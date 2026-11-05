import type { ConnectorKind } from "./connectors";

/**
 * What a member does in a service's own console before connecting it, step by step, shown on the
 * connection's page. Consoles change: each connector's `docs` link stays the reference.
 */
export const CONNECTOR_SETUP: Partial<Record<ConnectorKind, readonly string[]>> = {
  sirene: ["Créez un compte sur portail-api.insee.fr et une application « simple ».", "Abonnez-la à l’API Sirene, plan Public, puis collez sa clé ici.", "L’API accepte 30 appels par minute."],
  inpi: ["Collez l’adresse et le mot de passe de votre compte INPI.", "Ses conditions limitent l’usage des données personnelles à des fins de prospection : Coldlyne s’en sert pour vous renseigner sur une entreprise, pas pour trouver qui contacter."],
  google_sheets: ["Connectez-vous avec le compte Google qui a accès à la feuille."],
  gmail: ["Connectez-vous avec la boîte qui enverra.", "Préférez un domaine d’envoi séparé de votre domaine principal, et demandez à votre assistant de le vérifier."],
  microsoft365: ["Connectez-vous avec la boîte qui enverra : elle doit être une vraie boîte Exchange.", "Selon votre organisation, un administrateur devra peut-être approuver Coldlyne."],
  smtp: ["Indiquez les serveurs et les ports donnés par votre hébergeur.", "Avec Gmail, créez un mot de passe d’application (validation en deux étapes requise).", "Pour Microsoft 365, utilisez plutôt sa connexion dédiée : l’authentification SMTP de base y disparaît."],
  brevo_sms: ["Créez une clé d’API et achetez des crédits SMS.", "L’expéditeur compte 11 lettres et chiffres au plus : on ne peut pas répondre à un expéditeur nommé, seuls les STOP reviennent.", "Vérifiez que votre usage respecte les conditions de Brevo, qui demandent un consentement préalable."],
  ovh_sms: ["Créez vos clés sur eu.api.ovh.com/createToken avec les droits GET /sms/{compte}, GET /sms/{compte}/* et POST /sms/{compte}/jobs.", "L’expéditeur doit être validé par OVHcloud, sur justificatif (environ 72 heures).", "Vérifiez que votre usage respecte les conditions d’OVHcloud, qui demandent un consentement préalable."],
  smsmode: ["Créez une clé d’API sur un compte qui a un canal marketing.", "L’expéditeur doit être autorisé par smsmode.", "Vérifiez que votre usage respecte les conditions de smsmode, qui demandent un consentement préalable."],
  merci_facteur: ["Récupérez l’identifiant du service et la clé secrète.", "Faites lever la restriction d’adresse IP (menu API ou support).", "L’identifiant d’utilisateur se trouve dans le menu Utilisateurs. Gardez du crédit sur le compte."],
  maileva: ["Récupérez le client ID et le secret, ainsi que votre identifiant et votre mot de passe Maileva.", "Maileva doit qualifier votre compte pour cet accès : son catalogue prévoit un échange préalable."],
  twilio: ["Récupérez l’Account SID et l’Auth token dans la console.", "Le numéro appelant doit appartenir au compte, ou y être vérifié.", "Rien d’autre à faire : Coldlyne indique son adresse de retour à chaque appel."],
  aircall: ["Créez un API ID et un token.", "Ajoutez un webhook sur l’adresse ci-dessous, avec l’événement call.ended.", "Chaque membre appelle depuis une ligne qui lui est attribuée, connecté à l’application Aircall."],
  ringover: ["Créez une clé d’API avec le droit d’appeler (Tableau de bord → Développeur → API).", "Sous Développeur → Webhooks, ajoutez l’adresse ci-dessous sur les événements de fin d’appel et d’appel manqué.", "Si vous définissez un secret de webhook, indiquez-le ici pour que Coldlyne vérifie la signature."],
  whatsapp_cloud: ["Créez un utilisateur système avec les droits business_management, whatsapp_business_management et whatsapp_business_messaging, et son jeton.", "Récupérez le Phone number ID, le WABA ID et l’App secret.", "Dans les webhooks de l’application Meta, utilisez l’adresse ci-dessous, sa valeur token comme jeton de vérification, et abonnez messages et user_preferences.", "Vos modèles de message doivent être approuvés par Meta avant tout envoi."],
  google_calendar: ["Connectez-vous avec le compte dont l’agenda reçoit vos rendez-vous."],
  microsoft_calendar: ["Connectez-vous avec le compte dont l’agenda reçoit vos rendez-vous."],
  calcom: ["Créez une clé d’API.", "Dans les webhooks de Cal.com, ajoutez l’adresse ci-dessous et sa valeur token comme secret."],
  calendly: ["Créez un jeton d’accès personnel avec les droits users:read et scheduled_events:read.", "Coldlyne relit vos réservations régulièrement : rien d’autre à configurer."],
  hubspot: ["Dans HubSpot, Développement → Clés → Clés de service → Créer.", "Droits : crm.objects.contacts.read et .write, crm.objects.companies.read et .write."],
  pipedrive: ["Votre jeton se trouve dans Paramètres → Préférences personnelles → API.", "Le sous-domaine est celui de l’adresse de votre compte."],
  sellsy: ["Dans Réglages → Portail Développeur, créez un accès de type Personnel : le secret n’est affiché qu’une fois.", "Droits : contacts, sociétés et commentaires en écriture, équipe en lecture."],
  axonaut: ["Votre clé se trouve sous l’icône de clé à molette en haut à droite → API."],
  nocrm: ["Créez une clé dans le panneau d’administration → API Keys : elle n’est affichée qu’une fois."],
  folk: ["Dans Réglages → API, créez une clé (offre Premium ou plus)."],
  slack: ["Sur api.slack.com/apps, créez ou ouvrez une application et activez Incoming Webhooks.", "Ajoutez un webhook à votre espace, choisissez le canal et copiez l’adresse."],
  webhook: ["Indiquez une adresse https publique : Coldlyne y envoie un événement de test dès la connexion.", "Chaque envoi est signé : votre service peut vérifier l’en-tête Coldlyne-Signature avec le secret affiché une fois connecté."],
  signups: ["Connectez, puis faites poster par votre site, côté serveur, chaque inscription à l’adresse affichée : { \"email\": \"ada@acme.fr\" }.", "Seules les inscriptions de personnes que vous avez contactées sont gardées et créditées."],
  postmaster: ["Ajoutez votre domaine sur postmaster.google.com et vérifiez-le.", "Connectez-vous ensuite avec ce compte Google. Google ne donne de chiffres qu’à partir de 50 destinataires Gmail par jour."],
  vercel_dns: ["Créez un jeton sur votre compte Vercel.", "Indiquez le Team ID si le domaine est dans une équipe et que le jeton couvre tout le compte."],
  cloudflare_dns: ["Créez un jeton avec les droits Zone : lire et DNS : modifier sur le domaine d’envoi."],
  ovh_dns: ["Créez vos clés sur eu.api.ovh.com/createToken avec les droits GET /domain/zone, GET /domain/zone/*, POST /domain/zone/*/record, PUT /domain/zone/*/record/* et POST /domain/zone/*/refresh."],
};
