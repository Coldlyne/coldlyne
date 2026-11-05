import type { Tried } from "@/application/connection-use";
import { ActionForm } from "@/components/try-button";
import { FIELD, Labelled } from "@/components/ui";
import { CHANNEL_NAMES, CHANNELS, CONDITION_NAMES, MERGE_FIELDS, STEP_CONDITIONS, type Channel, type StepCondition } from "@/domain/sequences";

export interface StepValues {
  channel: string;
  waitDays: number;
  condition: StepCondition;
  subject: string | null;
  body: string;
  options: { template?: string; language?: string; parameters?: string[]; recordingUrl?: string };
}

const EMPTY: StepValues = { channel: "email", waitDays: 0, condition: "always", subject: null, body: "", options: {} };

/** A step's fields: to add one, or to rewrite one while it runs. */
export function StepForm({ action, values = EMPTY, submit }: { action: (previous: Tried | null, form: FormData) => Promise<Tried>; values?: StepValues; submit: string }) {
  return (
    <ActionForm action={action} submit={submit} busy="Enregistrement…" quiet>
      <div className="grid gap-3 sm:grid-cols-3">
        <Labelled label="Canal">
          <select name="channel" defaultValue={values.channel} className={FIELD}>
            {CHANNELS.map((channel: Channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_NAMES[channel]}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled label="Délai (jours)">
          <input name="waitDays" type="number" min={0} defaultValue={values.waitDays} className={FIELD} />
        </Labelled>
        <Labelled label="Quand">
          <select name="condition" defaultValue={values.condition} className={FIELD}>
            {STEP_CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {CONDITION_NAMES[condition]}
              </option>
            ))}
          </select>
        </Labelled>
      </div>
      <Labelled label="Objet (email)" hint="Laissez vide pour rester dans le même fil.">
        <input name="subject" defaultValue={values.subject ?? ""} className={FIELD} />
      </Labelled>
      <Labelled label="Texte" hint={`Champs : ${MERGE_FIELDS.map((field) => `{{${field}}}`).join(", ")}. Avec une valeur de repli : {{firstName|Bonjour}}.`}>
        <textarea name="body" required rows={5} defaultValue={values.body} className={FIELD} />
      </Labelled>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">WhatsApp et message vocal</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Labelled label="Modèle WhatsApp approuvé">
            <input name="template" defaultValue={values.options.template ?? ""} className={FIELD} />
          </Labelled>
          <Labelled label="Langue du modèle">
            <input name="language" defaultValue={values.options.language ?? "fr"} className={FIELD} />
          </Labelled>
          <Labelled label="Paramètres du modèle" hint="Séparés par | : {{firstName}} | {{company}}">
            <input name="parameters" defaultValue={values.options.parameters?.join(" | ") ?? ""} className={FIELD} />
          </Labelled>
          <Labelled label="Adresse du message vocal enregistré">
            <input name="recordingUrl" type="url" defaultValue={values.options.recordingUrl ?? ""} className={FIELD} />
          </Labelled>
        </div>
      </details>
    </ActionForm>
  );
}
