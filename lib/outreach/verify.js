// The last check before a draft reaches Soham's review list. Anything we
// aren't sure about goes to "Needs a look" with the reason instead, so he
// never has to double-check a business by hand before sending.

const { nameKey, stateCode } = require('./util');
const { GENERIC_NAME_WORDS } = require('./enrich');

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|att|sbcglobal|verizon|cox|charter|optonline|protonmail|proton|gmx|mail|zoho|frontier|snet|earthlink)\.[a-z.]+$/;

// Words in the business's name that identify it ("frog" in Call the Frog).
function distinctiveWords(name) {
  return nameKey(name).split(' ').filter(w => w.length >= 3 && !GENERIC_NAME_WORDS.test(w) && !/^(the|and|of|for|llc|inc|corp|co)$/.test(w));
}

function readinessProblems(p) {
  const problems = [];
  if (!p.town || !p.state) problems.push("We don't know which town it's in.");
  const reg = p.registry;
  // A Connecticut filing with no office address and a mailing address in
  // another state: the business is somewhere in CT, but we don't know where.
  if (p.source === 'registry' && reg && reg.location_from === 'mailing' && reg.mailing_state && stateCode(reg.mailing_state) !== 'CT') {
    problems.push(`The Connecticut filing only gives a mailing address in ${stateCode(reg.mailing_state)}, so we don't know where the business itself is.`);
  }
  if (p.email) {
    const [local, dom] = String(p.email).toLowerCase().split('@');
    if (dom && !FREE_MAIL.test(dom)) {
      const site = String(p.domain || '').toLowerCase();
      const onTheirSite = site && (dom === site || dom.endsWith(`.${site}`) || site.endsWith(`.${dom}`));
      const words = distinctiveWords(p.name);
      const named = words.some(w => dom.includes(w) || local.includes(w));
      if (!onTheirSite && words.length && !named) {
        problems.push(`The email address (${p.email}) is on ${dom}, which isn't their website and doesn't match the business name.`);
      }
    }
  }
  return problems;
}

module.exports = { readinessProblems, distinctiveWords };
