const explicitAiLive = import.meta.env.VITE_AI_LIVE?.trim().toLowerCase();
const explicitPublicShowcase = import.meta.env.VITE_PUBLIC_SHOWCASE?.trim().toLowerCase();

export const AI_LIVE_ENABLED =
  explicitAiLive === "1" ||
  explicitAiLive === "true" ||
  explicitAiLive === "yes" ||
  (!explicitAiLive && import.meta.env.DEV);

export const PUBLIC_SHOWCASE_BUILD =
  explicitPublicShowcase === "1" ||
  explicitPublicShowcase === "true" ||
  explicitPublicShowcase === "yes";

export const HOSTED_PLAYGROUND_NOTICE =
  "Public showcase: live collaboration is enabled. AI generation turns on when a demo AI backend is configured.";
