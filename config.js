// Public configuration. Everything in this file is visible to anyone who opens
// the website, so it must contain ONLY public values.
//
//   SUPABASE_URL              Supabase → Project Settings → API → Project URL
//   SUPABASE_PUBLISHABLE_KEY  the "publishable" (or legacy "anon") key
//
// NEVER put the service_role / secret key here.
window.APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://supabase.com/dashboard/project/anyuvpincmhtgonhkqhf",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable__Y05BztjYyOL_kBlL4YDTg_mBfFvR2h",

  // Students type "T017"; the app signs in as t017@<EMAIL_DOMAIN> behind the scenes.
  // Must match EMAIL_DOMAIN in .env.
  EMAIL_DOMAIN: "coders-club.example",

  // Supabase needs passwords of 6+ characters, but the starting password "T001"
  // has four. The app prepends this fixed text before sending the password, and
  // the provisioning script does the same. It is NOT a secret and does not
  // weaken anything; it just lets short passwords work. Must match .env.
  PASSWORD_PREFIX: "csps::"
});
