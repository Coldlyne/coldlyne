import type { CrmContact } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { requestJson } from "../http";
import { checkAccount, type CrmCompany, type CrmRecords, jsonHeaders, jsonInit, known, pushThrough, sameText } from "./push";

/**
 * Axonaut, through API v2: companies, their employees, and events.
 *
 * Docs: https://axonaut.com/api/v2/doc
 *       https://support.axonaut.com/connectez-axonaut/axonaut-zapier-connectez-vos-meilleurs-logiciels/
 *
 * Its write schemas have no website, no SIREN and no job title, and an employee's company is set
 * once and for all at creation. The SIREN and website go in the company's comments so they aren't
 * lost; the role is left out. The doc doesn't say whether its filters match exactly, so every
 * search is checked on what comes back.
 */

const PROVIDER = "Axonaut";
const API = "https://axonaut.com/api/v2";
/** Axonaut's event natures: 6 is a note. */
const NOTE = 6;

interface AxonautCompany {
  id: number;
  name?: string;
  siret?: string | null;
}

interface Employee {
  id: number;
  firstname?: string | null;
  lastname?: string | null;
  email?: string | null;
}

type Call = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const caller =
  (context: AdapterContext): Call =>
  <T>(path: string, method = "GET", body?: unknown) =>
    requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, jsonInit(method, jsonHeaders({ userApiKey: context.fields.apiKey }), body));

/** A SIRET starts with its company's SIREN. */
const hasSiren = (company: AxonautCompany, siren: string) => company.siret?.startsWith(siren) ?? false;

/** Under this name, the company with no other SIREN than this one. */
const namesake = (companies: AxonautCompany[], { name, siren }: CrmCompany) => companies.find((company) => sameText(company.name, name) && (!siren || !company.siret || hasSiren(company, siren))) ?? null;

const employeeFields = (contact: CrmContact) => known({ firstname: contact.firstName, lastname: contact.lastName, email: contact.email, phone_number: contact.phone });

function axonautRecords(call: Call, context: AdapterContext): CrmRecords<AxonautCompany, Employee> {
  /** The company whose SIRET starts with this SIREN, in case the filter matches part of a number. */
  async function bySiren(siren: string | null): Promise<AxonautCompany | null> {
    if (!siren) return null;
    return (await call<AxonautCompany[]>(`/companies?siret=${encodeURIComponent(siren)}`)).find((company) => hasSiren(company, siren)) ?? null;
  }

  return {
    async findCompany(company) {
      return (await bySiren(company.siren)) ?? namesake(await call<AxonautCompany[]>(`/companies?search=${encodeURIComponent(company.name)}`), company);
    },

    /** Nothing Coldlyne knows can be updated on a company once created. */
    async saveCompany(company, found) {
      if (found) return String(found.id);
      const comments = [company.siren && `SIREN ${company.siren}`, company.website].filter(Boolean).join("\n");
      return String((await call<AxonautCompany>("/companies", "POST", { name: company.name, is_prospect: "true", ...known({ comments }) })).id);
    },

    async findPerson({ email, firstName, lastName }, companyId) {
      if (email) return (await call<Employee[]>(`/employees?email=${encodeURIComponent(email)}`)).find((employee) => sameText(employee.email, email)) ?? null;
      const employees = await call<Employee[]>(`/companies/${companyId}/employees`);
      return employees.find((employee) => sameText(employee.lastname, lastName) && (!firstName || !employee.firstname || sameText(employee.firstname, firstName))) ?? null;
    },

    async savePerson(contact, companyId, found) {
      if (!found) return String((await call<Employee>("/employees", "POST", { company_id: Number(companyId), ...employeeFields(contact) })).id);
      await call(`/employees/${found.id}`, "PATCH", employeeFields(contact));
      return String(found.id);
    },

    /** An event names its person by address only: without one, it lands on the company alone. */
    async addNote(contact, _personId, companyId) {
      await call("/events", "POST", { company_id: Number(companyId), ...known({ employee_email: contact.email }), date: context.now().toISOString(), title: "Coldlyne", content: contact.note, nature: NOTE, is_done: "true" });
    },
  };
}

/** The account's name: the spec types `account` as a list, of one account for a key. */
async function accountName(call: Call): Promise<string> {
  const me = await call<{ fullname?: string; account?: { company_name?: string }[] | { company_name?: string } }>("/me");
  return [me.account].flat()[0]?.company_name || me.fullname || PROVIDER;
}

export const axonaut: Adapter = (context) => {
  const call = caller(context);
  return {
    check: () => checkAccount(() => accountName(call)),
    pushContact: (contact) => pushThrough(axonautRecords(call, context), contact),
  };
};
