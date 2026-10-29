// Shared "does this look like a real person's name" heuristic, used by
// both the page scraper (api/scrape.js) and the search-based discovery
// (api/search.js). Not perfect — a filter for obvious junk, not a
// verifier of real people.

const NAME_RE = /^[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,3}$/;

// Words that show up in site chrome, cookie banners, section titles, and
// generic search-result boilerplate — filtered out even though they can
// otherwise look like a capitalized multi-word phrase.
const BANNED_WORDS = new Set([
  'cookie', 'cookies', 'tracking', 'protection', 'consent', 'privacy',
  'party', 'third-party', 'enhanced', 'persistent', 'strict', 'custom',
  'block', 'blocking', 'manually', 'choose', 'section', 'settings',
  'preferences', 'nominate', 'nomination', 'nominations', 'inductees',
  'inductee', 'members', 'member', 'alumni', 'alumnus', 'hall', 'fame',
  'read', 'more', 'contact', 'learn', 'apply', 'about', 'team', 'our',
  'get', 'involved', 'quick', 'links', 'skip', 'menu', 'search', 'login',
  'sign', 'subscribe', 'newsletter', 'share', 'follow', 'accept', 'decline',
  'notable', 'featured', 'spotlight', 'profiles', 'news', 'events',
  'linkedin', 'facebook', 'twitter', 'instagram', 'youtube', 'university',
  'connecticut', 'uconn', 'school', 'college', 'department', 'office',
  'engagement', 'external', 'foundation', 'magazine', 'today', 'welcome',
  'home', 'page', 'pages', 'sitemap', 'site', 'directory', 'staff', 'faculty',
  'student', 'students', 'admissions', 'giving', 'donate', 'calendar', 'view',
  'all', 'a-z', 'index', 'map', 'accessibility', 'title', 'ix', 'copyright',
]);

// A broad, deliberately diverse set of real first names. Generic English
// phrases that happen to be capitalized two-word strings ("Session
// Management", "Quick Search") almost never start with an actual first
// name, so requiring the first word to match one kills that whole class
// of junk without needing a blocklist of every possible non-name phrase.
// Trade-off: a genuinely uncommon first name not in this list gets
// rejected too — false positives (junk shown as a lead) are worse than
// false negatives (a rare name missed) for this use case, so the list
// errs toward broad coverage rather than narrow precision.
const FIRST_NAMES = new Set([
  'aaron','abigail','adam','adrian','aiden','aisha','alan','albert','alex','alexander',
  'alexandra','alexis','alice','alicia','allison','amanda','amber','amelia','amir','amy',
  'andre','andrea','andrew','andy','angela','anita','ann','anna','anthony','antonio',
  'april','arjun','arthur','ashley','austin','avery','barbara','ben','benjamin','beth',
  'bethany','bianca','bill','billy','blake','bob','bobby','brandon','brenda','brendan',
  'brian','brianna','brittany','brooke','bruce','bryan','caitlin','caleb','cameron','carl',
  'carla','carlos','carmen','carol','caroline','carolyn','carrie','casey','catherine','cathy',
  'charles','charlie','charlotte','chelsea','cheryl','chloe','chris','christian','christina','christine',
  'christopher','cindy','claire','clara','claudia','cliff','colin','connor','courtney','craig',
  'crystal','curtis','cynthia','dan','dana','daniel','daniela','danielle','danny','darius',
  'darren','dave','david','dawn','dean','deb','deborah','debra','denise','dennis',
  'derek','devin','diana','diane','dominic','don','donald','donna','doris','dorothy',
  'doug','douglas','drew','dustin','dylan','edward','elaine','eleanor','elena','eli',
  'elias','elijah','elise','elizabeth','ella','ellen','elliot','emily','emma','eric',
  'erica','erik','erin','ethan','eugene','eva','evan','evelyn','faith','felipe',
  'fernando','fiona','frances','francis','francisco','frank','franklin','fred','gabriel','gabriela',
  'gabrielle','garrett','gary','gavin','gene','george','gerald','gina','giovanni','glenn',
  'gloria','gordon','grace','grant','greg','gregory','hailey','hannah','harold','harry',
  'heather','helen','henry','holly','howard','hunter','ian','ibrahim','isaac','isabel',
  'isabella','ivan','jack','jackson','jacob','jacqueline','jade','jaime','james','jamie',
  'jane','janet','janice','jared','jasmine','jason','jay','jean','jeff','jeffrey',
  'jennifer','jenny','jeremy','jerry','jesse','jessica','jill','jim','jimmy','joan',
  'joanna','joe','joel','john','johnny','jonathan','jordan','jorge','jose','joseph',
  'joshua','joy','joyce','juan','judith','judy','julia','julian','julie','julio',
  'justin','kaitlyn','kara','karen','karl','katherine','kathleen','kathryn','kathy','katie',
  'katherine','katrina','kayla','keith','kelly','kelsey','ken','kenneth','kevin','kim',
  'kimberly','kris','kristen','kristin','kristina','kyle','lance','larry','laura','lauren',
  'laurie','lawrence','leah','lee','leo','leon','leonard','leslie','leung','lewis',
  'liam','liang','lin','linda','lindsay','lindsey','lisa','liu','logan','lori',
  'lorraine','louis','lucas','lucy','luis','luke','lydia','lynn','mackenzie','madison',
  'maggie','maha','malik','manuel','marc','marco','marcus','margaret','maria','mariam',
  'marie','marilyn','mario','marissa','mark','marsha','martha','martin','marvin','mary',
  'mason','mateo','matt','matthew','maureen','max','maxwell','maya','megan','melanie',
  'melinda','melissa','meredith','miao','michael','michelle','miguel','mike','mikhail','miranda',
  'mohammed','molly','monica','morgan','muhammad','nancy','naomi','natalie','natasha','nathan',
  'nathaniel','neil','nicholas','nicole','nina','noah','nora','norman','olivia','omar',
  'oscar','owen','pamela','patricia','patrick','paul','paula','pedro','peggy','peter',
  'philip','phillip','phoebe','phyllis','priya','rachel','rahul','ralph','ramon','randy',
  'raul','raymond','rebecca','regina','renee','ricardo','richard','rick','riley','rita',
  'rob','robert','roberto','robin','rodney','roger','ron','ronald','rosa','rose',
  'ross','roy','russell','ruth','ryan','sam','samantha','samuel','sandra','sara',
  'sarah','scott','sean','sebastian','shane','shannon','sharon','shaun','shawn','sheila',
  'shirley','sidney','simon','sofia','sonia','sophia','sophie','stacey','stacy','stanley',
  'stephanie','stephen','steve','steven','stuart','sun','susan','suzanne','sydney','sylvia',
  'tamara','tanya','tara','taylor','teresa','terrence','terry','thomas','tiffany','tim',
  'timothy','tina','todd','tom','tony','tracey','tracy','travis','trevor','tyler',
  'valerie','vanessa','vera','vernon','veronica','victor','victoria','vincent','virginia','vivian',
  'walter','wang','warren','wayne','wei','wendy','wesley','will','william','xavier',
  'xin','yan','yolanda','yousef','yuki','yusuf','yves','zachary','zack','zainab',
  'zhang','zoe',
  // Short/nickname first names easy to miss above but common enough to
  // matter — added after a real miss ("Ray Allen") slipped through.
  'ray','roy','nick','jon','jan','guy','zach','abby','bob','ed','al',
  'cody','cole','wade','chad','clay','dale','earl','hank','ira','ivy',
  'jed','jude','kurt','lars','lou','mac','mel','milo','moe','ned',
  'otis','pete','phil','quinn','rex','rick','rod','russ','seth','stan',
  'ted','theo','troy','van','vic','wes','zeke','ana','abdul','hassan',
  'khalid','tariq','wael','deja','jaylen','malik','tyrone','marcus',
  // More international first names — a US-centric list keeps missing
  // real people at exactly the rate you'd expect.
  'hans','klaus','dieter','erik','lars','sven','bjorn','henrik','stefan','ingrid',
  'astrid','freya','matteo','luca','marco','giulia','francesca','elena','paolo','stefano',
  'jean','pierre','francois','antoine','philippe','claude','henri','nicolas','olivier','sebastien',
  'pablo','javier','diego','alejandro','fernanda','isabel','mateus','joao','pedro','rafael',
  'bruno','felix','gustavo','chen','wei','jing','hui','ming','yong','feng',
  'hiroshi','kenji','takashi','yuji','akira','satoshi','minho','jihoon','seojun','haruto',
  'arjun','vikram','rohan','ravi','sanjay','deepak','anand','kiran','nikhil','vivek',
  'fatima','layla','noor','yasmin','samir','tariq','omar','zaid','amina','leila',
  'ngozi','chidi','kwame','amara','folake','oluwaseun','ade','chinedu','thabo','sipho',
  'olga','irina','dmitri','sergei','natasha','anastasia','viktor','pavel','tomasz','anna',
]);

// Alumni pages routinely format a name as "Sarah Thomas '04 (CLAS)" —
// class year and college abbreviation baked right into the heading.
// Strip that trailing pattern before validating (a plain digit anywhere
// is still a good "this isn't a name" signal — a price, a year alone,
// a phone number — just not when it's this specific, extremely common
// class-year suffix).
const CLASS_YEAR_SUFFIX = /\s*['’]\d{2}\s*(\([A-Za-z&]{2,8}\))?\s*$/;

function looksLikeName(text) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  if (!t || t.length > 45) return false;
  const base = t.replace(CLASS_YEAR_SUFFIX, '').trim();
  if (!base) return false;
  if (/\d/.test(base)) return false;
  if (!NAME_RE.test(base)) return false;
  const words = base.toLowerCase().split(/\s+/);
  if (words.some(w => BANNED_WORDS.has(w))) return false;
  const firstWord = words[0].replace(/[^a-z]/g, '');
  if (!FIRST_NAMES.has(firstWord)) return false;
  return true;
}

// Common UConn subdomains carry plenty of pages about current faculty
// and staff, not alumni — different problem from topic relevance, so
// handled separately and narrowly (excluding a specific known category,
// not trying to guess general relevance). Also catches byline/credit
// text ("Story by...", "Photo by...") that occasionally gets paired
// with a name by the extractor — that text describes the ARTICLE, not
// the person it got attached to.
const NOT_ALUMNI_TERMS = [
  'professor', 'faculty', 'lecturer', 'dean of', 'department chair',
  'adjunct', 'postdoctoral', 'graduate student', 'undergraduate student',
  'phd candidate', 'doctoral candidate', 'research assistant', 'teaching assistant',
];
const BYLINE_RE = /^(story|photo|article|written|reported|interview)\s+by\b/i;

function isNotAlumniBio(bio) {
  if (!bio) return false;
  if (BYLINE_RE.test(bio.trim())) return true;
  const b = bio.toLowerCase();
  return NOT_ALUMNI_TERMS.some(term => b.includes(term));
}

// Blocklisting every sports/entertainment term that could show up on a
// "notable alumni" page is a losing game (mls, emmy, all-american,
// figure skater, animator, ... the list never ends). Flip it: Connect.AI
// wants tech/business/consulting leads specifically, so require the bio
// to actually signal that, instead of trying to name everything it isn't.
const RELEVANT_BIO_TERMS = [
  'business', 'founder', 'co-founder', 'entrepreneur', 'startup', 'start-up',
  'ceo', 'cfo', 'coo', 'cto', 'chief executive', 'chief operating',
  'chief financial', 'chief technology', 'president', 'vice president',
  'executive', 'director', 'manager', 'partner', 'board member',
  'engineer', 'engineering', 'software', 'developer', 'programmer',
  'product manager', 'technology', 'tech company', 'ai ', 'artificial intelligence',
  'machine learning', 'data scien', 'data analy', 'consultant', 'consulting',
  'finance', 'financial', 'investment', 'venture cap', 'private equity',
  'banking', 'analyst', 'marketing', 'sales', 'operations', 'strategy',
  'industry', 'company', 'corporation', 'firm', 'enterprise', 'nonprofit',
  'organization', 'law firm', 'attorney', 'real estate', 'healthcare',
  'medicine', 'physician', 'biotech', 'pharmaceutical',
];

function isRelevantBio(bio) {
  if (!bio) return false;
  const b = bio.toLowerCase();
  return RELEVANT_BIO_TERMS.some(term => b.includes(term));
}

module.exports = { looksLikeName, isRelevantBio, isNotAlumniBio, NAME_RE, BANNED_WORDS };
