// Defaults for everything the dashboard's Settings panel can change.
// Saved overrides live in outreach_settings.data and are merged on top.

const DEFAULT_SETTINGS = {
  sender_name: 'Soham Shah',
  sender_major: 'accounting',
  // Where Soham has worked / is headed. Used in the "why I'm writing" line.
  past_internship: 'Henkel',
  next_internship: 'Andersen',
  linkedin_url: 'https://www.linkedin.com/in/soham-shah-uconn/',
  signature: 'Soham Shah\nUniversity of Connecticut',
  apply_url: 'connect-ai.world/apply',
  // One optional sentence about timing, e.g. "We're picking partners for
  // the spring semester now." Left blank, the email doesn't mention timing.
  offer_note: '',

  // Sending. A new Gmail account that suddenly sends 100 cold emails a
  // day gets flagged; 15–25/day with a slow ramp is the safe range.
  daily_cap: 20,
  per_tick: 4,
  send_start_hour: 8,   // New York time
  send_end_hour: 16,
  send_weekdays_only: true,

  followups_enabled: true,
  followup_after_days: 4, // business days with no reply

  // Off: every email waits for you to read it and click Approve.
  // On: drafts at or above the fit score below queue themselves (never
  // guessed addresses).
  auto_queue: false,
  auto_queue_min_fit: 70,

  // Sourcing
  max_miles: 45,
  min_pipeline: 40,     // keep at least this many found/ready prospects on hand
  use_osm: true,
  use_registry: true,
};

function mergeSettings(saved) {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

module.exports = { DEFAULT_SETTINGS, mergeSettings };
