/* eslint-disable no-console -- command-line script: progress is printed to the terminal */
/**
 * Demo scenario: fills a freshly seeded development database with a believable two-to-three
 * week story for Njenga Greens Ltd, by driving the REAL API as the right role for each step.
 * It doubles as an end-to-end test: any unexpected non-2xx response stops the run.
 *
 * Usage (development only, on an empty database):
 *   npm run db:reset -- --yes && npm run db:migrate && npm run db:seed:demo
 *   npm run demo:scenario            # API must be running (npm run dev)
 *
 * Env: API_URL (default http://localhost:9019/api/v1), SEED_DIRECTOR_EMAIL /
 * SEED_DIRECTOR_PASSWORD (read from .env), DEMO_PASSWORD (default Demo@2026).
 */
import { crc32, deflateSync } from 'node:zlib';

const API = process.env.API_URL ?? 'http://localhost:9019/api/v1';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@2026';
const DIRECTOR = {
  email: process.env.SEED_DIRECTOR_EMAIL,
  password: process.env.SEED_DIRECTOR_PASSWORD,
};

// ---------------------------------------------------------------- dates

const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);
/** Today in Africa/Kigali (UTC+2) as YYYY-MM-DD. */
const TODAY = iso(new Date(Date.now() + 2 * 3_600_000));
/** A date `n` days before today. */
const ago = (n) => iso(new Date(Date.parse(TODAY) - n * DAY));
const ahead = (n) => iso(new Date(Date.parse(TODAY) + n * DAY));
const month = (offset = 0) => {
  const d = new Date(Date.parse(TODAY));
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return iso(d).slice(0, 7);
};
const monthStart = (offset = 0) => `${month(offset)}-01`;
const monthEnd = (offset = 0) => {
  const d = new Date(Date.parse(monthStart(offset + 1)) - DAY);
  return iso(d);
};
/** Kigali local time on a given date, as an ISO datetime with offset. */
const at = (date, hhmm) => `${date}T${hhmm}:00+02:00`;

// ---------------------------------------------------------------- HTTP

class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body?.error ?? body)}`);
    this.status = status;
    this.body = body;
  }
}

async function call(token, method, path, body, { form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

let stepCount = 0;
function session(name, token) {
  const req = async (method, path, body, opts) => {
    const { status, json } = await call(token, method, path, body, opts);
    if (status < 200 || status >= 300) throw new ApiError(method, path, status, json);
    stepCount++;
    return json?.data ?? json;
  };
  return {
    name,
    token,
    get: (p) => req('GET', p),
    post: (p, b = {}) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    patch: (p, b) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
    /** Attach files to a record through the documents endpoint. */
    upload: (entityType, entityId, files) => {
      const form = new FormData();
      form.append('entityType', entityType);
      form.append('entityId', String(entityId));
      for (const f of files) form.append('files', new Blob([f.data], { type: f.type }), f.name);
      return req('POST', '/documents', undefined, { form });
    },
    /** Expect a refusal (negative permission / business-rule checks). */
    expect: async (status, method, path, body) => {
      const res = await call(token, method, path, body);
      if (res.status !== status) {
        throw new ApiError(method, path, res.status, {
          error: { message: `expected ${status}`, got: res.json },
        });
      }
      console.log(`  ✓ ${name}: ${method} ${path} refused with ${status}`);
    },
  };
}

async function login(email, password) {
  const { status, json } = await call(null, 'POST', '/auth/login', {
    identifier: email,
    password,
  });
  if (status !== 200) throw new ApiError('POST', '/auth/login', status, json);
  return session(json.data.user.name, json.data.token);
}

function step(title) {
  console.log(`\n▸ ${title}`);
}

// ---------------------------------------------------------------- small real files

/** A one-page PDF with a title and a few lines of text. */
function makePdf(title, lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = [
    'BT /F2 18 Tf 56 780 Td (Njenga Greens Ltd) Tj ET',
    `BT /F2 14 Tf 56 752 Td (${esc(title)}) Tj ET`,
    ...lines.map((l, i) => `BT /F1 11 Tf 56 ${718 - i * 18} Td (${esc(l)}) Tj ET`),
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Store-only ZIP (enough for a valid .docx). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const buf = Buffer.from(data);
    const crc = crc32(buf);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(buf.length, 18);
    local.writeUInt32LE(buf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(buf.length, 20);
    central.writeUInt32LE(buf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, buf);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + buf.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** A small Word document with a heading and paragraphs. */
function makeDocx(title, paragraphs) {
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const para = (t, bold) =>
    `<w:p><w:r>${bold ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r></w:p>`;
  const body = [para(title, true), ...paragraphs.map((p) => para(p))].join('');
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

/** A PNG "site photo": sky, green rows of crops/greenhouse arches, soil. */
function makePng(seed, width = 480, height = 320) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      let r, g, b;
      if (y < height * 0.35) {
        const t = y / (height * 0.35);
        [r, g, b] = [150 + 60 * t, 195 + 30 * t, 235];
      } else if (y < height * 0.8) {
        const stripe = Math.sin((x + seed * 13) / (9 + (seed % 5))) > 0.2;
        const arch = Math.abs(((x + seed * 7) % 120) - 60) < 3;
        [r, g, b] = arch ? [235, 235, 230] : stripe ? [47, 107, 58] : [88, 150, 70];
      } else {
        [r, g, b] = [120 + (x % 7), 85, 55];
      }
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pdf = (name, title, lines) => ({
  name,
  type: 'application/pdf',
  data: makePdf(title, lines),
});
const docx = (name, title, paragraphs) => ({
  name,
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  data: makeDocx(title, paragraphs),
});
const photo = (name, seed) => ({ name, type: 'image/png', data: makePng(seed) });

// ---------------------------------------------------------------- scenario

async function main() {
  if (!DIRECTOR.email || !DIRECTOR.password) {
    throw new Error('SEED_DIRECTOR_EMAIL / SEED_DIRECTOR_PASSWORD are not set (.env)');
  }
  console.log(`Demo scenario against ${API} (today ${TODAY})`);

  step('Sign in as every role');
  const dir = await login(DIRECTOR.email, DIRECTOR.password);
  const oa = await login('office@njengagreens.local', DEMO_PASSWORD);
  const bdm = await login('bdm@njengagreens.local', DEMO_PASSWORD);
  const ops = await login('operations@njengagreens.local', DEMO_PASSWORD);
  const tech1 = await login('tech1@njengagreens.local', DEMO_PASSWORD);
  const tech2 = await login('tech2@njengagreens.local', DEMO_PASSWORD);
  const farm = await login('farm@njengagreens.local', DEMO_PASSWORD);
  const agro = await login('agronomist@njengagreens.local', DEMO_PASSWORD);

  const existing = await dir.get('/projects?pageSize=1');
  if ((Array.isArray(existing) ? existing.length : 0) > 0) {
    throw new Error('The database already has projects. Reset and re-seed it first (see header).');
  }

  const people = await dir.get('/users/options');
  const uid = (name) => {
    const u = people.find((p) => p.name === name);
    if (!u) throw new Error(`User ${name} not found`);
    return u.id;
  };
  const U = {
    dir: people.find((p) => p.roleCode === 'director').id,
    oa: uid('Grace Uwase'),
    bdm: uid('Shruthi Nair'),
    ops: uid('Eric Mugisha'),
    tech1: uid('Jean Habimana'),
    tech2: uid('Patrick Nshimiye'),
    farm: uid('Alice Mukamana'),
    agro: uid('Dr. Samuel Kato'),
  };

  const categories = await oa.get('/finance/categories');
  const cat = (name) => {
    const c = categories.find((x) => x.name === name);
    if (!c) throw new Error(`Category ${name} missing`);
    return c.id;
  };

  // ------------------------------------------------------------ CRM
  step('Business development: customers, leads, interactions');
  const rwamagana = await bdm.post('/crm/customers', {
    name: 'Rwamagana Horticulture Cooperative',
    type: 'company',
    email: 'info@rwamaganahort.example',
    phone: '+250788410220',
    address: 'Kigabiro sector, Rwamagana, Eastern Province',
    notes:
      '<p>Cooperative of <strong>212 smallholder members</strong> growing tomatoes and peppers for Kigali markets.</p><ul><li>Pays in two instalments (50 % deposit)</li><li>Prefers site meetings on Thursdays</li></ul>',
  });
  await bdm.post(`/crm/customers/${rwamagana.id}/contacts`, {
    name: 'Claudine Uwimana',
    position: 'Cooperative President',
    phone: '+250788410221',
    email: 'claudine@rwamaganahort.example',
  });
  const musanze = await bdm.post('/crm/customers', {
    name: 'Musanze Highland Farms Ltd',
    type: 'company',
    email: 'ops@musanzehighland.example',
    phone: '+250788552310',
    address: 'Muhoza sector, Musanze, Northern Province',
    notes: '<p>Potato and vegetable grower near Volcanoes NP. Repeat customer.</p>',
  });
  const kigaliFresh = await bdm.post('/crm/customers', {
    name: 'Kigali Fresh Market Ltd',
    type: 'company',
    email: 'buying@kigalifresh.example',
    phone: '+250788300400',
    address: 'KN 4 Ave, Nyarugenge, Kigali',
    notes: '<p>Buys tomatoes, sweet peppers and cucumbers from the NGL farm every week.</p>',
  });
  await bdm.post('/crm/customers', {
    name: 'Jean-Pierre Ndayisaba',
    type: 'individual',
    phone: '+250788123987',
    address: 'Nyamata, Bugesera',
    notes: '<p>Private farmer interested in a small greenhouse kit.</p>',
  });

  const leadWon = await bdm.post('/crm/leads', {
    title: 'Drip irrigation for 2 ha avocado orchard',
    companyName: 'Bugesera Agro Ventures Ltd',
    contactName: 'Olivier Habyarimana',
    contactPhone: '+250788640115',
    contactEmail: 'olivier@bugeseraagro.example',
    source: 'Referral (RAB extension officer)',
    estimatedValue: 22_000_000,
    expectedCloseDate: ago(12),
  });
  for (const stage of ['contacted', 'proposal_sent', 'negotiation', 'won']) {
    await bdm.post(`/crm/leads/${leadWon.id}/stage`, { stage });
  }
  const leadProposal = await bdm.post('/crm/leads', {
    title: 'Three greenhouse tunnels with drip kits',
    companyName: 'Kinigi Vegetable Growers',
    contactName: 'Esther Mukeshimana',
    contactPhone: '+250788775501',
    source: 'Agrishow Kigali',
    estimatedValue: 18_600_000,
    expectedCloseDate: ahead(21),
    followUpDate: ahead(2),
  });
  for (const stage of ['contacted', 'proposal_sent']) {
    await bdm.post(`/crm/leads/${leadProposal.id}/stage`, { stage });
  }
  const leadNegotiation = await bdm.post('/crm/leads', {
    title: 'Solar-powered pump and sprinkler system',
    companyName: 'Nyagatare Dairy & Fodder Co.',
    contactName: 'Didier Ntwari',
    contactPhone: '+250788900233',
    source: 'Website enquiry',
    estimatedValue: 31_500_000,
    expectedCloseDate: ahead(10),
    followUpDate: TODAY,
  });
  for (const stage of ['contacted', 'proposal_sent', 'negotiation']) {
    await bdm.post(`/crm/leads/${leadNegotiation.id}/stage`, { stage });
  }
  const leadContacted = await bdm.post('/crm/leads', {
    title: 'Nursery shade house 600 m²',
    companyName: 'Huye Seedlings Cooperative',
    contactName: 'Aimable Twagiramungu',
    contactPhone: '+250788211904',
    source: 'Cold call',
    estimatedValue: 6_400_000,
    expectedCloseDate: ahead(35),
    followUpDate: ahead(5),
  });
  await bdm.post(`/crm/leads/${leadContacted.id}/stage`, { stage: 'contacted' });
  await bdm.post('/crm/leads', {
    title: 'Rooftop hydroponics pilot',
    companyName: 'Kigali Heights Residences',
    contactName: 'Sandrine Iradukunda',
    contactPhone: '+250788610077',
    contactEmail: 'facilities@kigaliheights.example',
    source: 'LinkedIn',
    estimatedValue: 9_800_000,
    expectedCloseDate: ahead(45),
    followUpDate: ahead(7),
  });
  const leadLost = await bdm.post('/crm/leads', {
    title: 'Flower farm irrigation upgrade',
    companyName: 'Rubavu Blooms Ltd',
    contactName: 'Fabrice Nkurunziza',
    source: 'Trade fair',
    estimatedValue: 14_200_000,
    expectedCloseDate: ago(5),
  });
  await bdm.post(`/crm/leads/${leadLost.id}/stage`, { stage: 'proposal_sent' });
  await bdm.post(`/crm/leads/${leadLost.id}/stage`, {
    stage: 'lost',
    lostReason: 'Client chose a cheaper supplier from Uganda; keep in touch for maintenance work.',
  });
  await bdm.post('/crm/interactions', {
    leadId: leadNegotiation.id,
    type: 'meeting',
    summary:
      '<p>Site visit in Nyagatare with Didier. Agreed on <strong>12 kW solar array</strong> and two 10 m³ tanks.</p><ul><li>Client asks for 3 instalments</li><li>Send revised quote by Friday</li></ul>',
    nextFollowUpDate: TODAY,
  });
  await bdm.post('/crm/interactions', {
    leadId: leadProposal.id,
    type: 'call',
    summary: '<p>Esther confirmed the cooperative board will review the proposal next week.</p>',
    nextFollowUpDate: ahead(2),
  });
  await bdm.post('/crm/interactions', {
    customerId: kigaliFresh.id,
    type: 'visit',
    summary: '<p>Delivered samples of grade A tomatoes; buyer happy with shelf life.</p>',
  });

  step('Convert the won lead into a customer and a project');
  const converted = await bdm.post(`/crm/leads/${leadWon.id}/convert`, {
    projectName: 'Bugesera avocado drip irrigation (2 ha)',
    location: 'Ntarama sector, Bugesera',
    startDate: ago(18),
    endDate: ago(3),
    projectLeadId: U.ops,
  });
  const bugeseraProjectId = converted.projectId;
  if (!bugeseraProjectId)
    throw new Error(`Unexpected convert response ${JSON.stringify(converted)}`);

  // ------------------------------------------------------------ projects
  step('Projects with teams');
  const pRwamagana = await bdm.post('/projects', {
    name: 'Rwamagana cooperative – 4 greenhouses',
    customerId: rwamagana.id,
    location: 'Kigabiro, Rwamagana',
    contractValue: 48_500_000,
    startDate: ago(25),
    endDate: ahead(32),
    projectLeadId: U.ops,
    description:
      '<h3>Scope</h3><ul><li>Four 8 × 30 m steel greenhouses with 200-micron UV polythene</li><li>Drip irrigation with fertigation tank</li><li>Training of 10 cooperative members</li></ul>',
    memberIds: [U.tech1, U.tech2],
  });
  await bdm.patch(`/projects/${bugeseraProjectId}`, {
    contractValue: 22_000_000,
    description:
      '<p>Drip irrigation for 800 avocado trees (Hass) fed from an existing borehole, with a 20 m³ header tank.</p>',
  });
  await ops.post(`/projects/${bugeseraProjectId}/members`, { userIds: [U.tech2] });
  const pMusanze = await bdm.post('/projects', {
    name: 'Musanze Highland Farms – borehole drip system',
    customerId: musanze.id,
    location: 'Muhoza, Musanze',
    contractValue: 15_800_000,
    startDate: ago(60),
    endDate: ago(10),
    projectLeadId: U.ops,
    description:
      '<p>Drip system for 1.5 ha of Irish potatoes and cabbages from a new borehole.</p>',
    memberIds: [U.tech1],
  });
  await bdm.post('/projects', {
    name: 'Kicukiro school garden irrigation',
    clientName: 'Groupe Scolaire Kicukiro',
    location: 'Kicukiro, Kigali',
    contractValue: 4_750_000,
    startDate: ahead(14),
    endDate: ahead(45),
    projectLeadId: U.bdm,
    description:
      '<p>Small drip and rainwater harvesting system for the school vegetable garden.</p>',
  });

  // ------------------------------------------------------------ finance
  step('Budgets for projects, farm and office');
  await oa.post('/finance/budgets', {
    name: 'Rwamagana greenhouses – project budget',
    costCentreType: 'project',
    projectId: pRwamagana.id,
    amount: 31_000_000,
    notes: 'Approved at the October management meeting.',
    lines: [
      { categoryId: cat('Materials'), amount: 20_000_000 },
      { categoryId: cat('Labour'), amount: 5_500_000 },
      { categoryId: cat('Transport'), amount: 2_000_000 },
      { categoryId: cat('Equipment'), amount: 3_500_000 },
    ],
  });
  await oa.post('/finance/budgets', {
    name: 'Bugesera drip irrigation – project budget',
    costCentreType: 'project',
    projectId: bugeseraProjectId,
    amount: 14_000_000,
    lines: [
      { categoryId: cat('Materials'), amount: 10_500_000 },
      { categoryId: cat('Labour'), amount: 2_500_000 },
      { categoryId: cat('Transport'), amount: 1_000_000 },
    ],
  });
  await oa.post('/finance/budgets', {
    name: 'Musanze borehole drip – project budget',
    costCentreType: 'project',
    projectId: pMusanze.id,
    amount: 10_500_000,
    lines: [
      { categoryId: cat('Materials'), amount: 7_500_000 },
      { categoryId: cat('Labour'), amount: 2_000_000 },
      { categoryId: cat('Transport'), amount: 1_000_000 },
    ],
  });
  await oa.post('/finance/budgets', {
    name: `Farm operating budget ${month()}`,
    costCentreType: 'farm',
    periodStart: monthStart(),
    periodEnd: monthEnd(),
    amount: 4_500_000,
    lines: [
      { categoryId: cat('Farm inputs'), amount: 1_800_000 },
      { categoryId: cat('Casual labour'), amount: 1_500_000 },
      { categoryId: cat('Utilities'), amount: 400_000 },
      { categoryId: cat('Maintenance'), amount: 800_000 },
    ],
  });
  await oa.post('/finance/budgets', {
    name: `Office running costs ${month()}`,
    costCentreType: 'office',
    periodStart: monthStart(),
    periodEnd: monthEnd(),
    amount: 2_800_000,
    lines: [
      { categoryId: cat('Utilities'), amount: 450_000 },
      { categoryId: cat('Communication'), amount: 250_000 },
      { categoryId: cat('Office supplies'), amount: 300_000 },
      { categoryId: cat('Fuel'), amount: 600_000 },
    ],
  });

  step('Musanze project: executed, completed, profit/loss analysed');
  await ops.post(`/projects/${pMusanze.id}/status`, {
    status: 'in_execution',
    note: 'Borehole drilled, team on site.',
  });

  step('Income and expenses recorded by the Office Administrator');
  const tx = (body) => oa.post('/finance/transactions', body);
  await tx({
    direction: 'in',
    transactionDate: ago(16),
    amount: 15_800_000,
    categoryId: cat('Project revenue'),
    costCentreType: 'project',
    projectId: pMusanze.id,
    paymentMethod: 'bank_transfer',
    reference: 'BK-TRF-88412',
    description: 'Musanze Highland Farms – final payment for the borehole drip system',
  });
  await tx({
    direction: 'in',
    transactionDate: ago(20),
    amount: 24_250_000,
    categoryId: cat('Project revenue'),
    costCentreType: 'project',
    projectId: pRwamagana.id,
    paymentMethod: 'bank_transfer',
    reference: 'BK-TRF-88291',
    description: 'Rwamagana cooperative – 50 % deposit',
  });
  await tx({
    direction: 'in',
    transactionDate: ago(14),
    amount: 11_000_000,
    categoryId: cat('Project revenue'),
    costCentreType: 'project',
    projectId: bugeseraProjectId,
    paymentMethod: 'bank_transfer',
    reference: 'EQ-TRF-30177',
    description: 'Bugesera Agro Ventures – 50 % advance',
  });
  for (const [days, amount, ref] of [
    [13, 1_850_000, 'KFM-INV-1042'],
    [6, 2_320_000, 'KFM-INV-1057'],
  ]) {
    await tx({
      direction: 'in',
      transactionDate: ago(days),
      amount,
      categoryId: cat('Farm produce sales'),
      costCentreType: 'farm',
      paymentMethod: 'mobile_money',
      reference: ref,
      description: 'Kigali Fresh Market – tomatoes, peppers and cucumbers',
    });
  }
  const musanzeExpenses = [
    [40, 6_100_000, 'Materials', 'Drip tape, PVC mains and filters (Musanze)', 'INV-AGRI-5521'],
    [35, 1_650_000, 'Labour', 'Installation crew, 3 weeks', 'MOMO-77120'],
    [30, 780_000, 'Transport', 'Truck hire Kigali–Musanze (2 trips)', 'TRK-0912'],
  ];
  for (const [days, amount, category, description, reference] of musanzeExpenses) {
    await tx({
      direction: 'out',
      transactionDate: ago(days),
      amount,
      categoryId: cat(category),
      costCentreType: 'project',
      projectId: pMusanze.id,
      paymentMethod: 'bank_transfer',
      reference,
      description,
    });
  }
  const expenses = [
    [
      15,
      185_000,
      'Utilities',
      'office',
      'EUCL electricity – office, last month',
      'EUCL-2231',
      'mobile_money',
    ],
    [12, 96_000, 'Communication', 'office', 'MTN business internet', 'MTN-55810', 'mobile_money'],
    [9, 145_000, 'Office supplies', 'office', 'Printer toner and A4 paper', 'SIM-7781', 'cash'],
    [8, 210_000, 'Fuel', 'office', 'Fuel for the double-cab pickup', 'SP-11902', 'cash'],
    [
      11,
      420_000,
      'Farm inputs',
      'farm',
      'Tomato seedlings (Anna F1) 2,000 plants',
      'SEED-3019',
      'mobile_money',
    ],
    [7, 260_000, 'Maintenance', 'farm', 'Repair of greenhouse 4 side vents', 'RP-0442', 'cash'],
    [5, 118_000, 'Utilities', 'farm', 'WASAC water bill – farm', 'WASAC-9930', 'mobile_money'],
    [
      10,
      2_350_000,
      'Materials',
      'project',
      'Steel tubes and hoops for greenhouses A & B',
      'INV-STL-2207',
      'bank_transfer',
      pRwamagana.id,
    ],
    [
      4,
      340_000,
      'Transport',
      'project',
      'Lorry Kigali–Rwamagana, steel delivery',
      'TRK-0977',
      'mobile_money',
      pRwamagana.id,
    ],
    [
      9,
      1_480_000,
      'Materials',
      'project',
      'HDPE 63 mm main line, 400 m',
      'INV-PIP-6610',
      'bank_transfer',
      bugeseraProjectId,
    ],
  ];
  for (const [days, amount, category, cc, description, reference, method, projectId] of expenses) {
    await tx({
      direction: 'out',
      transactionDate: ago(days),
      amount,
      categoryId: cat(category),
      costCentreType: cc,
      projectId: projectId ?? null,
      paymentMethod: method,
      reference,
      description,
    });
  }
  const fuelReceipt = await tx({
    direction: 'out',
    transactionDate: ago(3),
    amount: 95_000,
    categoryId: cat('Fuel'),
    costCentreType: 'project',
    projectId: pRwamagana.id,
    paymentMethod: 'cash',
    reference: 'SP-12044',
    description: 'Diesel for generator on site',
  });
  await oa.upload('transaction', fuelReceipt.id, [
    pdf('fuel-receipt-SP-12044.pdf', 'Fuel receipt SP-12044', [
      'SP Kabuga station – 60 L diesel',
      'Amount: RWF 95,000',
      `Date: ${ago(3)}`,
    ]),
  ]);

  step('Duplicate reference warning (US-OA-003 AC3)');
  await oa.expect(409, 'POST', '/finance/transactions', {
    direction: 'out',
    transactionDate: ago(2),
    amount: 95_000,
    categoryId: cat('Fuel'),
    costCentreType: 'office',
    paymentMethod: 'cash',
    reference: 'SP-12044',
  });

  step('An entry recorded by mistake, then deleted (restorable by a Director)');
  const mistake = await tx({
    direction: 'out',
    transactionDate: ago(2),
    amount: 145_000,
    categoryId: cat('Office supplies'),
    costCentreType: 'office',
    paymentMethod: 'cash',
    reference: 'SIM-7781-B',
    description: 'Printer toner (entered twice by mistake)',
  });
  await oa.del(`/finance/transactions/${mistake.id}`);

  step('Musanze completion and P/L analysis');
  await ops.post(`/projects/${pMusanze.id}/status`, {
    status: 'completed',
    note: 'Handed over; client signed the completion certificate.',
  });
  await bdm.post(`/projects/${pMusanze.id}/pl-analysis`, {
    note: 'Under budget on materials thanks to bulk HDPE purchase; labour slightly over.',
  });
  await bdm.post('/crm/ratings', {
    projectId: pMusanze.id,
    rating: 5,
    comment: 'Very professional team, system working perfectly.',
  });
  await bdm.post('/crm/sales', {
    customerId: musanze.id,
    projectId: pMusanze.id,
    amount: 15_800_000,
    saleDate: ago(16),
    description: 'Borehole drip system – full contract',
  });
  await bdm.post('/crm/sales', {
    customerId: rwamagana.id,
    projectId: pRwamagana.id,
    amount: 48_500_000,
    saleDate: ago(25),
    description: 'Four greenhouses with drip irrigation',
  });

  step('Loan from the bank: receipt, use of funds, repayment');
  const loan = await oa.post('/finance/loans', {
    lender: 'Bank of Kigali – Agri loan',
    principal: 30_000_000,
    interestRate: 16,
    interestCharged: 2_400_000,
    startDate: ago(45),
    termMonths: 24,
    repaymentSchedule: 'Monthly instalments of RWF 1,350,000 on the 5th, from the second month.',
    purpose: 'Working capital for greenhouse construction projects',
  });
  await oa.post(`/finance/loans/${loan.id}/receipts`, {
    receivedDate: ago(44),
    amount: 30_000_000,
    paymentMethod: 'bank_transfer',
    reference: 'BK-LN-2026-0458',
  });
  await tx({
    direction: 'out',
    transactionDate: ago(10),
    amount: 3_900_000,
    categoryId: cat('Materials'),
    costCentreType: 'project',
    projectId: pRwamagana.id,
    paymentMethod: 'bank_transfer',
    reference: 'INV-POLY-1180',
    description: 'UV polythene 200 micron, 6 rolls (funded by BK loan)',
    loanId: loan.id,
  });
  await oa.post(`/finance/loans/${loan.id}/repayments`, {
    paymentDate: ago(13),
    amount: 1_350_000,
    paymentMethod: 'bank_transfer',
    reference: 'BK-RP-11',
    notes: 'First instalment',
  });
  await oa.upload('loan', loan.id, [
    pdf('BK-loan-agreement.pdf', 'Loan agreement BK-LN-2026-0458', [
      'Lender: Bank of Kigali',
      'Principal: RWF 30,000,000 at 16 % p.a.',
      'Term: 24 months',
    ]),
  ]);

  // ------------------------------------------------------------ tasks
  step('Tasks for the project teams');
  const task = (s, body) => s.post('/tasks', body);
  const tFrames = await task(ops, {
    title: 'Erect steel frames for greenhouses A and B',
    description: 'Follow drawing NGL-RW-02. Check foundations are level before bolting.',
    projectId: pRwamagana.id,
    assigneeId: U.tech1,
    priority: 'high',
    deadline: ahead(4),
  });
  const tDrip = await task(ops, {
    title: 'Lay drip lines in greenhouses A and B',
    projectId: pRwamagana.id,
    assigneeId: U.tech2,
    priority: 'medium',
    deadline: ahead(12),
  });
  const tPoly = await task(ops, {
    title: 'Confirm polythene delivery with supplier',
    projectId: pRwamagana.id,
    assigneeId: U.tech1,
    priority: 'medium',
    deadline: ago(6),
  });
  const tTrench = await task(ops, {
    title: 'Dig trench and lay the 63 mm main line',
    projectId: bugeseraProjectId,
    assigneeId: U.tech2,
    priority: 'urgent',
    deadline: ago(2),
  });
  const tTank = await task(ops, {
    title: 'Install 20 m³ header tank on the stand',
    projectId: bugeseraProjectId,
    assigneeId: U.tech2,
    priority: 'high',
    deadline: ahead(3),
  });
  await task(bdm, {
    title: 'Prepare revised quote for Nyagatare solar pump',
    description: 'Three-instalment option, include 12 kW array.',
    assigneeId: U.bdm,
    priority: 'high',
    deadline: ahead(1),
  });
  await task(farm, {
    title: 'Clean and disinfect water tank at the farm',
    assigneeId: U.farm,
    priority: 'medium',
    deadline: ahead(2),
  });
  await tech1.post(`/tasks/${tPoly.id}/status`, { status: 'done' });
  await tech1.post(`/tasks/${tFrames.id}/status`, { status: 'in_progress' });
  await tech2.post(`/tasks/${tTrench.id}/status`, { status: 'in_progress' });
  await tech2.post(`/tasks/${tTank.id}/status`, { status: 'blocked' });
  void tDrip;

  // ------------------------------------------------------------ requests
  step('Requests in every state');
  const reqFunding = await ops.post('/requests', {
    type: 'funding',
    amount: 3_200_000,
    purpose: 'Polythene, clips and gutters for greenhouses C and D (Rwamagana)',
    categoryId: cat('Materials'),
    costCentreType: 'project',
    projectId: pRwamagana.id,
    neededBy: ahead(5),
  });
  await ops.upload('request', reqFunding.id, [
    pdf('quote-agriplast-Q-2231.pdf', 'Quotation Q-2231 – Agriplast Rwanda', [
      '6 rolls UV polythene 200 micron 8 x 50 m',
      '1,200 spring clips and profiles',
      '60 m galvanised gutter',
      'Total: RWF 3,200,000 (VAT incl.)',
    ]),
  ]);
  await oa.post(`/requests/${reqFunding.id}/forward`, {
    comment: 'Within the Materials budget line. Quote attached.',
  });
  await dir.post(`/requests/${reqFunding.id}/approve`, { comment: 'Approved – proceed.' });
  await oa.post(`/requests/${reqFunding.id}/disburse`, {
    amount: 3_200_000,
    paidOn: ago(1),
    paymentMethod: 'bank_transfer',
    paymentReference: 'BK-TRF-89120',
  });

  const reqBugesera = await ops.post('/requests', {
    type: 'funding',
    amount: 2_100_000,
    purpose: 'Drip laterals 16 mm and 800 pressure-compensating emitters (Bugesera)',
    categoryId: cat('Materials'),
    costCentreType: 'project',
    projectId: bugeseraProjectId,
    neededBy: ago(4),
  });
  await oa.post(`/requests/${reqBugesera.id}/forward`, {});
  await dir.post(`/requests/${reqBugesera.id}/approve`, {});
  await oa.post(`/requests/${reqBugesera.id}/disburse`, {
    amount: 2_100_000,
    paidOn: ago(4),
    paymentMethod: 'mobile_money',
    paymentReference: 'MOMO-81233',
  });

  const reqFertiliser = await farm.post('/requests', {
    type: 'purchase',
    amount: 380_000,
    purpose: 'NPK 17-17-17 fertiliser, 10 bags of 50 kg for greenhouses 1–4',
    categoryId: cat('Farm inputs'),
    costCentreType: 'farm',
    neededBy: ahead(3),
  });
  await oa.post(`/requests/${reqFertiliser.id}/forward`, {});
  await dir.post(`/requests/${reqFertiliser.id}/approve`, {
    comment: 'Approved. Buy from the usual supplier in Kabuga.',
  });

  const reqStand = await bdm.post('/requests', {
    type: 'funding',
    amount: 1_200_000,
    purpose: 'Exhibition stand at the Kigali Agrishow (3 days)',
    categoryId: cat('Other'),
    costCentreType: 'office',
    neededBy: ahead(20),
  });
  await oa.post(`/requests/${reqStand.id}/forward`, {});
  await dir.expect(400, 'POST', `/requests/${reqStand.id}/reject`, { reason: '' });
  await dir.post(`/requests/${reqStand.id}/reject`, {
    reason: 'Not in this quarter’s marketing budget. Resubmit in January with a smaller stand.',
  });

  const reqFungicide = await agro.post('/requests', {
    type: 'purchase',
    amount: 165_000,
    purpose: 'Fungicide (Mancozeb 80 WP, 5 kg) and a 16 L knapsack sprayer for late blight',
    categoryId: cat('Farm inputs'),
    costCentreType: 'farm',
    neededBy: ahead(1),
  });
  await oa.post(`/requests/${reqFungicide.id}/forward`, {
    comment: 'Urgent – blight found in greenhouse 2.',
  });

  const reqPipes = await tech1.post('/requests', {
    type: 'purchase',
    amount: 450_000,
    purpose: 'PVC pipes 50 mm (20 lengths) and fittings for the fertigation tank',
    categoryId: cat('Materials'),
    costCentreType: 'project',
    projectId: pRwamagana.id,
    neededBy: ahead(6),
  });
  await tech1.post(`/requests/${reqPipes.id}/comments`, {
    comment: 'Hardware in Kabuga has them in stock; quote to follow.',
  });

  const reqEmitters = await tech2.post('/requests', {
    type: 'purchase',
    amount: 90_000,
    purpose: 'Extra drip emitters',
    costCentreType: 'project',
    projectId: bugeseraProjectId,
  });
  await oa.post(`/requests/${reqEmitters.id}/return`, {
    comment: 'Please add the quantity, the category and a supplier quote.',
  });

  step('Business rules on requests');
  await oa.expect(422, 'POST', `/requests/${reqPipes.id}/disburse`, {
    amount: 450_000,
    paidOn: TODAY,
    paymentMethod: 'cash',
    paymentReference: 'X-1',
  });

  // ------------------------------------------------------------ project lifecycle
  step('Projects into execution');
  for (const id of [pRwamagana.id, bugeseraProjectId]) {
    await ops.post(`/projects/${id}/status`, { status: 'in_execution', note: 'Crew mobilised.' });
  }

  // ------------------------------------------------------------ field reports
  step('Technician progress reports (rich text + attachments)');
  const report1 = await tech1.post('/field/progress-reports', {
    projectId: pRwamagana.id,
    reportDate: ago(2),
    percentComplete: 35,
    workCompleted:
      '<h2>Greenhouse A – frame complete</h2><p>Foundations for greenhouses A and B were checked and the <strong>steel frame of greenhouse A</strong> is fully bolted.</p><ul><li>14 hoops installed and braced</li><li>Gable ends fixed, door frame in place</li><li>Anchor bolts torqued and checked</li></ul><table><thead><tr><th>Item</th><th>Planned</th><th>Done</th></tr></thead><tbody><tr><td>Hoops (A)</td><td>14</td><td>14</td></tr><tr><td>Hoops (B)</td><td>14</td><td>6</td></tr><tr><td>Gutters</td><td>60 m</td><td>0 m</td></tr></tbody></table>',
    pendingWork:
      '<ol><li>Finish hoops for greenhouse B</li><li>Fit gutters once delivered</li><li>Start drip lines in A</li></ol>',
    issuesSummary: '<p>Two foundation pads in B are 3 cm low – will shim them tomorrow.</p>',
    latitude: -1.9487,
    longitude: 30.4347,
    clientRef: 'demo-rw-report-0001',
    attachmentCount: 3,
  });
  await tech1.upload('progress_report', report1.id, [
    pdf('Rwamagana-progress-week2.pdf', 'Progress report – Rwamagana greenhouses (week 2)', [
      'Greenhouse A: frame 100 %',
      'Greenhouse B: frame 45 %',
      'Greenhouses C and D: foundations only',
      'Overall progress: 35 %',
    ]),
    photo('greenhouse-A-frame.png', 1),
    photo('greenhouse-B-hoops.png', 4),
  ]);
  const report0 = await tech1.post('/field/progress-reports', {
    projectId: pRwamagana.id,
    reportDate: ago(9),
    percentComplete: 15,
    workCompleted:
      '<p>Site cleared and levelled. <strong>16 foundation pads</strong> cast for greenhouses A and B.</p>',
    pendingWork: '<p>Wait 7 days for concrete to cure before erecting frames.</p>',
    clientRef: 'demo-rw-report-0000',
  });
  const report2 = await tech2.post('/field/progress-reports', {
    projectId: bugeseraProjectId,
    reportDate: ago(1),
    percentComplete: 60,
    workCompleted: '',
    issuesSummary: '<p>Pressure at the far end of block 3 is low; see the issue raised.</p>',
    clientRef: 'demo-bg-report-0001',
    attachmentCount: 1,
  });
  await tech2.upload('progress_report', report2.id, [
    docx('Bugesera-site-report.docx', 'Bugesera drip irrigation – site report', [
      'Main line: 400 m laid and pressure-tested at 3 bar.',
      'Laterals: blocks 1 and 2 complete (520 trees), block 3 in progress.',
      'Header tank stand finished; tank delivery expected this week.',
      'Progress: 60 %.',
    ]),
  ]);

  step('Operations Manager verifies, queries; technician responds');
  await ops.post(`/field/progress-reports/${report0.id}/verify`, {
    comment: 'Checked the pads on site – good work.',
  });
  await ops.post(`/field/progress-reports/${report1.id}/verify`, {});
  await ops.post(`/field/progress-reports/${report2.id}/query`, {
    comment: '60 % looks high while the tank is not installed. Please confirm block 3 figures.',
  });
  await tech2.post(`/field/progress-reports/${report2.id}/respond`, {
    response: 'Block 3 laterals are laid but not connected; corrected to 55 %.',
    percentComplete: 55,
  });

  step('Issues');
  const issueHigh = await tech2.post('/field/issues', {
    projectId: bugeseraProjectId,
    progressReportId: report2.id,
    title: 'Low water pressure at the far end of block 3',
    description:
      '<p>Pressure drops to <strong>0.6 bar</strong> at the last 40 trees. Borehole pump may be undersized for the full block.</p>',
    severity: 'high',
  });
  const issueMedium = await tech1.post('/field/issues', {
    projectId: pRwamagana.id,
    progressReportId: report1.id,
    title: 'Two foundation pads 3 cm low in greenhouse B',
    severity: 'medium',
  });
  await ops.post(`/field/issues/${issueMedium.id}/resolve`, {
    resolution: '<p>Pads shimmed with steel plates and re-levelled. Checked on site visit.</p>',
  });
  void issueHigh;

  step('Site visit and daily operations report');
  const visit = await ops.post('/field/site-visits', {
    projectId: pRwamagana.id,
    visitDate: ago(1),
    findings:
      '<h3>Findings</h3><ul><li>Greenhouse A frame <strong>straight and well braced</strong></li><li>Greenhouse B pads corrected</li><li>Polythene stored on pallets, covered</li></ul><p><em>Safety:</em> two workers without helmets – reminded the crew.</p>',
    attachmentCount: 1,
  });
  await ops.upload('site_visit', visit.id, [photo('site-visit-rwamagana.png', 7)]);
  await ops.post('/field/site-visits', {
    projectId: bugeseraProjectId,
    visitDate: ago(5),
    findings: '<p>Main line trench depth OK (60 cm). Backfilling started on the eastern side.</p>',
  });
  await ops.get(`/field/daily-ops/prefill?date=${ago(1)}`);
  await ops.post('/field/daily-ops', {
    reportDate: ago(1),
    comments:
      '<p>Both running projects on site today.</p><ul><li><strong>Rwamagana:</strong> frame of greenhouse B at 45 %, gutters awaited.</li><li><strong>Bugesera:</strong> pressure problem in block 3 – pump supplier contacted.</li></ul>',
  });

  // ------------------------------------------------------------ inventory
  step('Inventory: materials, receipts, issues');
  const mat = (body) => ops.post('/inventory/materials', body);
  const mPoly = await mat({
    name: 'UV polythene 200 micron (8 × 50 m)',
    sku: 'POLY-200',
    unit: 'roll',
    reorderLevel: 4,
  });
  const mDrip = await mat({
    name: 'Drip tape 16 mm (1,000 m reel)',
    sku: 'DRIP-16',
    unit: 'reel',
    reorderLevel: 5,
  });
  const mPvc = await mat({
    name: 'PVC pipe 50 mm (6 m length)',
    sku: 'PVC-50',
    unit: 'length',
    reorderLevel: 20,
  });
  const mNpk = await mat({
    name: 'NPK 17-17-17 fertiliser (50 kg)',
    sku: 'NPK-17',
    unit: 'bag',
    reorderLevel: 6,
  });
  const mShade = await mat({
    name: 'Shade net 50 % (4 × 50 m)',
    sku: 'SHADE-50',
    unit: 'roll',
    reorderLevel: 3,
  });
  const mSteel = await mat({
    name: 'Galvanised steel tube 40 mm',
    sku: 'STL-40',
    unit: 'length',
    reorderLevel: 30,
  });
  const receive = (m, body) => ops.post(`/inventory/materials/${m.id}/receive`, body);
  await receive(mPoly, {
    quantity: 10,
    unitCost: 520_000,
    supplier: 'Agriplast Rwanda',
    movementDate: ago(15),
    paymentMethod: 'bank_transfer',
  });
  await receive(mDrip, {
    quantity: 12,
    unitCost: 145_000,
    supplier: 'Netafim (via Mombasa)',
    isImported: true,
    shipmentReference: 'MSA-CTN-44812',
    movementDate: ago(12),
    paymentMethod: 'bank_transfer',
  });
  await receive(mPvc, {
    quantity: 60,
    unitCost: 9_500,
    supplier: 'Kabuga Hardware',
    movementDate: ago(11),
    paymentMethod: 'cash',
  });
  await receive(mNpk, {
    quantity: 12,
    unitCost: 38_000,
    supplier: 'Agro-Input Centre Kabuga',
    movementDate: ago(9),
    paymentMethod: 'mobile_money',
  });
  await receive(mShade, {
    quantity: 4,
    unitCost: 210_000,
    supplier: 'Agriplast Rwanda',
    movementDate: ago(15),
    paymentMethod: 'bank_transfer',
  });
  await receive(mSteel, {
    quantity: 120,
    unitCost: 21_000,
    supplier: 'Steelrwa Industries',
    movementDate: ago(14),
    paymentMethod: 'bank_transfer',
  });
  const issue = (m, body) => ops.post(`/inventory/materials/${m.id}/issue`, body);
  await issue(mPoly, {
    quantity: 4,
    costCentreType: 'project',
    projectId: pRwamagana.id,
    movementDate: ago(8),
  });
  await issue(mSteel, {
    quantity: 84,
    costCentreType: 'project',
    projectId: pRwamagana.id,
    movementDate: ago(10),
  });
  await issue(mDrip, {
    quantity: 6,
    costCentreType: 'project',
    projectId: bugeseraProjectId,
    movementDate: ago(7),
  });
  await issue(mNpk, {
    quantity: 4,
    costCentreType: 'farm',
    movementDate: ago(6),
    notes: 'Top dressing GH 1–4',
  });
  await issue(mShade, {
    quantity: 3,
    costCentreType: 'farm',
    movementDate: ago(4),
    notes: 'Nursery shading',
  });
  await ops.post(`/inventory/materials/${mPvc.id}/adjust`, {
    quantity: -2,
    reason: 'Two lengths cracked during unloading',
    movementDate: ago(10),
  });

  // ------------------------------------------------------------ farm
  step('Greenhouses');
  const ghDefs = [
    ['Greenhouse 1', 'Tomatoes (Anna F1)', 75, 'active', 480],
    ['Greenhouse 2', 'Tomatoes (Nemonetta)', 68, 'active', 480],
    ['Greenhouse 3', 'Sweet pepper (red)', 90, 'active', 480],
    ['Greenhouse 4', 'Cucumber (Super Marketer)', 40, 'active', 360],
    ['Greenhouse 5', 'Strawberries', 120, 'active', 360],
    ['Greenhouse 6', null, null, 'maintenance', 360],
  ];
  const gh = [];
  for (const [name, crop, plantedAgo, status, size] of ghDefs) {
    gh.push(
      await farm.post('/farm/greenhouses', {
        name,
        kind: 'greenhouse',
        sizeSqm: size,
        currentCrop: crop,
        plantingDate: plantedAgo ? ago(plantedAgo) : null,
        status,
        notes: status === 'maintenance' ? 'Polythene replacement after hail damage.' : null,
      }),
    );
  }
  gh.push(
    await farm.post('/farm/greenhouses', {
      name: 'Open field block A',
      kind: 'field_block',
      sizeSqm: 2500,
      currentCrop: 'French beans',
      plantingDate: ago(50),
      status: 'active',
    }),
  );

  step('Casual workers and attendance');
  const workerDefs = [
    ['Claudine Mukandayisenga', '1198870012345671', '+250788501101', 3000],
    ['Emmanuel Nsengiyumva', '1199080023456782', '+250788501102', 3000],
    ['Vestine Uwamahoro', '1199270034567893', '+250788501103', 3000],
    ['Theogene Bizimana', '1198580045678904', '+250788501104', 3500],
    ['Josiane Nyirahabimana', '1200070056789015', '+250788501105', 3000],
    ['Innocent Hakizimana', '1199670067890126', '+250788501106', 3500],
  ];
  const workers = [];
  for (const [fullName, nationalId, phone, dailyRate] of workerDefs) {
    workers.push(
      await farm.post('/payroll/casual-workers', {
        fullName,
        nationalId,
        phone,
        dailyRate,
        siteType: 'farm',
      }),
    );
  }
  for (const [fullName, nationalId, dailyRate] of [
    ['Olivier Niyonsenga', '1199370078901237', 4000],
    ['Eric Twizeyimana', '1198970089012348', 4000],
  ]) {
    await ops.post('/payroll/casual-workers', {
      fullName,
      nationalId,
      dailyRate,
      siteType: 'project',
      projectId: pRwamagana.id,
    });
  }
  // Two working weeks of attendance (Mon–Sat), a few absences.
  const workDays = [];
  for (let n = 14; n >= 0; n--) {
    const d = ago(n);
    if (new Date(d).getUTCDay() !== 0) workDays.push(d);
  }
  for (const [i, date] of workDays.entries()) {
    await farm.put('/payroll/attendance', {
      date,
      entries: workers.map((w, j) => ({ workerId: w.id, present: (i + j) % 7 !== 3 })),
    });
  }

  step('Daily farm reports');
  const entry = (g, extra = {}) => ({
    greenhouseId: g.id,
    greenhouseStatus: 'Normal',
    cropHealth: 'good',
    irrigationDone: true,
    severity: 'none',
    ...extra,
  });
  for (const n of [3, 2, 1, 0]) {
    const blight = n <= 2;
    await farm.post('/farm/reports', {
      reportDate: ago(n),
      irrigationNotes:
        'Drip irrigation 2 × 25 min in all active greenhouses; tank refilled at 14:00.',
      visitors: n === 1 ? 'Kigali Fresh Market buyer (Mr. Kayitare) – quality check' : null,
      equipmentCondition:
        n === 0
          ? 'Fertigation pump OK. Greenhouse 6 still under repair.'
          : 'All equipment working.',
      generalNotes: blight
        ? `<p>Routine scouting done in all greenhouses.</p><ul><li><strong>Greenhouse 2:</strong> late blight lesions on lower leaves – agronomist informed, affected leaves removed.</li><li>Greenhouse 4 cucumbers flowering well.</li></ul><p>Workers present: ${5 + (n % 2)} of 6.</p>`
        : '<p>Calm day. Harvest of tomatoes in greenhouse 1, pruning in greenhouse 3.</p>',
      clientRef: `demo-farm-report-${n}`,
      entries: [
        entry(gh[0]),
        entry(
          gh[1],
          blight
            ? {
                cropHealth: 'fair',
                greenhouseStatus: 'Blight observed',
                pestsObserved: 'Late blight (Phytophthora) on lower leaves',
                severity: n === 0 ? 'high' : 'medium',
              }
            : {},
        ),
        entry(gh[2], { pestsObserved: 'A few whiteflies on sticky traps', severity: 'low' }),
        entry(gh[3]),
        entry(gh[4]),
        entry(gh[5], {
          greenhouseStatus: 'Under maintenance',
          irrigationDone: false,
          cropHealth: 'good',
        }),
        entry(gh[6]),
      ],
    });
  }
  const latestFarm = await farm.get(`/farm/reports/daily?date=${TODAY}`);
  if (latestFarm?.id) {
    await farm.upload('farm_report', latestFarm.id, [photo('greenhouse-2-blight.png', 11)]);
  }

  step('Harvests');
  const harvests = [
    [0, 13, 420, 'A'],
    [0, 9, 385, 'A'],
    [0, 5, 410, 'A'],
    [0, 1, 60, 'B'],
    [1, 12, 300, 'A'],
    [1, 6, 240, 'B'],
    [2, 11, 150, 'A'],
    [2, 4, 175, 'A'],
    [3, 8, 520, 'A'],
    [3, 3, 610, 'A'],
    [3, 0, 80, 'C'],
    [4, 7, 45, 'A'],
    [4, 2, 52, 'A'],
    [6, 10, 260, 'A'],
  ];
  for (const [g, n, quantity, grade] of harvests) {
    await farm.post('/farm/harvests', {
      greenhouseId: gh[g].id,
      quantity,
      unit: 'kg',
      grade,
      harvestDate: ago(n),
    });
  }

  step('Agronomist inspections (one high severity)');
  const inspHigh = await agro.post('/farm/inspections', {
    greenhouseId: gh[1].id,
    inspectionDate: ago(1),
    severity: 'high',
    diseaseIdentified: 'Late blight (Phytophthora infestans)',
    findings:
      '<h3>Late blight – Greenhouse 2</h3><p>About <strong>30 % of plants</strong> show water-soaked lesions on the lower leaves; first stem lesions on the eastern side.</p><table><thead><tr><th>Row</th><th>Plants affected</th><th>Stage</th></tr></thead><tbody><tr><td>1–4</td><td>12 %</td><td>Leaves</td></tr><tr><td>5–8</td><td>41 %</td><td>Leaves + stems</td></tr></tbody></table><p>Humidity has been above 90 % at night; side vents were closed.</p>',
    recommendedTreatment:
      '<ol><li>Remove and burn infected leaves today</li><li>Spray Mancozeb 80 WP at 2.5 g/L, repeat after 7 days</li><li>Open side vents every morning to reduce humidity</li></ol>',
    recommendedFertiliser: '<p>Reduce nitrogen; foliar potassium (KNO₃ 1 %) once a week.</p>',
    followUpDate: ahead(2),
    status: 'open',
  });
  await agro.upload('inspection', inspHigh.id, [photo('GH2-late-blight.png', 15)]);
  await agro.post('/farm/inspections', {
    greenhouseId: gh[3].id,
    inspectionDate: ago(4),
    severity: 'medium',
    diseaseIdentified: 'Powdery mildew',
    findings: '<p>White powdery patches on older cucumber leaves, mainly near the door.</p>',
    recommendedTreatment: '<p>Sulphur 80 WG at 3 g/L; improve airflow.</p>',
    followUpDate: ago(1),
    status: 'treated',
  });
  const inspFile = await agro.post('/farm/inspections', {
    greenhouseId: gh[2].id,
    inspectionDate: ago(6),
    severity: 'low',
    diseaseIdentified: 'Whitefly (low pressure)',
    findings: '',
    withReportFile: true,
    followUpDate: ahead(8),
  });
  await agro.upload('inspection', inspFile.id, [
    docx('GH3-inspection-report.docx', 'Inspection report – Greenhouse 3 (sweet pepper)', [
      'Whitefly counts: 3–5 per yellow trap per week (threshold 10).',
      'No virus symptoms observed.',
      'Recommendation: keep yellow traps, release Encarsia if counts exceed threshold.',
    ]),
  ]);
  await agro.post('/farm/inspections', {
    greenhouseId: gh[0].id,
    inspectionDate: ago(8),
    severity: 'none',
    findings: '<p>Healthy crop, good fruit set on trusses 4–6. No pests found.</p>',
    recommendedFertiliser: '<p>Continue weekly fertigation with calcium nitrate.</p>',
    status: 'closed',
  });

  // ------------------------------------------------------------ payroll
  step('Employees and payroll');
  const empDefs = [
    ['Grace Uwase', U.oa, 'Office Administrator', 'Administration', 650_000, 80_000, 'office'],
    [
      'Shruthi Nair',
      U.bdm,
      'Business Development Manager',
      'Business Development',
      1_100_000,
      150_000,
      'office',
    ],
    ['Eric Mugisha', U.ops, 'Operations Manager', 'Operations', 950_000, 120_000, 'office'],
    [
      'Jean Habimana',
      U.tech1,
      'Lead Technician',
      'Operations',
      480_000,
      60_000,
      'project',
      pRwamagana.id,
    ],
    [
      'Patrick Nshimiye',
      U.tech2,
      'Technician',
      'Operations',
      380_000,
      50_000,
      'project',
      bugeseraProjectId,
    ],
    ['Alice Mukamana', U.farm, 'Farm Manager', 'Farm', 600_000, 70_000, 'farm'],
    ['Dr. Samuel Kato', U.agro, 'Agronomist', 'Farm', 750_000, 90_000, 'farm'],
    ['Jean Bosco Hategekimana', null, 'Driver', 'Administration', 250_000, 30_000, 'office'],
  ];
  for (const [
    fullName,
    userId,
    jobTitle,
    department,
    basicSalary,
    allowances,
    cc,
    projectId,
  ] of empDefs) {
    await oa.post('/payroll/employees', {
      fullName,
      userId,
      jobTitle,
      department,
      basicSalary,
      allowances,
      deductions: Math.round(basicSalary * 0.03),
      hireDate: '2024-02-01',
      costCentreType: cc,
      projectId: projectId ?? null,
      bankAccount: `BK-0004-${String(1000 + (userId ?? 99)).padStart(6, '0')}`,
    });
  }
  const run = await oa.post('/payroll/runs', { period: month(-1) });
  await oa.post(`/payroll/runs/${run.id}/pay`, {
    paidOn: ago(17),
    paymentMethod: 'bank_transfer',
    reference: `SAL-${month(-1)}`,
  });
  await oa.post('/payroll/runs', { period: month() });

  step('Casual pay run (farm, last two weeks) paid');
  const casualRun = await oa.post('/payroll/casual-runs', {
    periodStart: ago(14),
    periodEnd: ago(1),
    siteType: 'farm',
  });
  await oa.post(`/payroll/casual-runs/${casualRun.id}/pay`, {
    paidOn: TODAY,
    paymentMethod: 'mobile_money',
    reference: 'MOMO-BULK-0412',
  });

  // ------------------------------------------------------------ meetings
  step('Meetings, minutes, action points');
  const meeting = await dir.post('/meetings', {
    title: 'Weekly management meeting',
    startsAt: at(ago(2), '08:30'),
    endsAt: at(ago(2), '10:00'),
    location: 'NGL office, Kicukiro – meeting room',
    agenda:
      '<ol><li>Project status: Rwamagana and Bugesera</li><li>Late blight in greenhouse 2</li><li>Cash position and loan repayment</li><li>Agrishow participation</li></ol>',
    participantIds: [U.oa, U.bdm, U.ops, U.farm, U.agro],
  });
  await dir.put(`/meetings/${meeting.id}/minutes`, {
    complete: true,
    minutes:
      '<h2>Minutes – weekly management meeting</h2><p><strong>Present:</strong> Director, Office Administrator, BDM, Operations Manager, Farm Manager, Agronomist.</p><h3>1. Projects</h3><ul><li>Rwamagana at 35 %; gutters to be delivered this week.</li><li>Bugesera behind schedule because of the pump – Ops to propose a solution.</li></ul><h3>2. Farm</h3><p>Late blight in greenhouse 2. Treatment approved; Agronomist to follow up in 48 h.</p><h3>3. Finance</h3><table><thead><tr><th>Item</th><th>Status</th></tr></thead><tbody><tr><td>BK loan instalment</td><td>Paid</td></tr><tr><td>Rwamagana 2nd instalment</td><td>Due on handover</td></tr></tbody></table><h3>Decisions</h3><ol><li>No Agrishow stand this quarter.</li><li>Order a larger pump for Bugesera.</li></ol>',
  });
  const ap1 = await dir.post(`/meetings/${meeting.id}/action-points`, {
    description: 'Get quotes for a 3 kW borehole pump for Bugesera',
    assigneeId: U.ops,
    dueDate: ahead(3),
  });
  await dir.post(`/meetings/${meeting.id}/action-points`, {
    description: 'Follow up late blight treatment in greenhouse 2 and report',
    assigneeId: U.agro,
    dueDate: ahead(2),
  });
  await dir.post(`/meetings/${meeting.id}/action-points`, {
    description: 'Send the Rwamagana cooperative the second instalment invoice schedule',
    assigneeId: U.oa,
    dueDate: ahead(7),
  });
  await dir.post(`/meetings/${meeting.id}/action-points/${ap1.id}/task`, {
    priority: 'high',
    projectId: bugeseraProjectId,
  });
  await bdm.post('/meetings', {
    title: 'Proposal presentation – Kinigi Vegetable Growers',
    startsAt: at(ahead(3), '14:00'),
    endsAt: at(ahead(3), '15:30'),
    link: 'https://meet.example.com/ngl-kinigi',
    agenda: '<p>Present the three-tunnel proposal and payment options.</p>',
    participantIds: [U.ops, U.dir],
  });
  await ops.post('/meetings', {
    title: 'Toolbox talk – working at height',
    startsAt: at(ahead(1), '07:30'),
    location: 'Rwamagana site',
    agenda: '<p>Safety briefing for the greenhouse crew before roof work.</p>',
    participantIds: [U.tech1, U.tech2],
  });

  // ------------------------------------------------------------ report requests
  step('Report requests from the Director');
  const rr = await dir.post('/reports/requests', {
    title: 'October financial summary for the board',
    description:
      '<p>Please prepare a short summary for the board meeting:</p><ul><li>Income and expenses by cost centre</li><li>Loan position</li><li>Cash position at month end</li></ul>',
    assigneeId: U.oa,
    dueDate: ago(1),
  });
  await oa.upload('report_request', rr.id, [
    pdf('October-financial-summary.pdf', 'October financial summary', [
      'Income: RWF 51,220,000',
      'Expenses: RWF 13,780,000',
      'Loan outstanding: RWF 31,050,000',
    ]),
  ]);
  await oa.post(`/reports/requests/${rr.id}/deliver`, {
    response:
      '<h3>October in brief</h3><p>Income was driven by the <strong>Rwamagana deposit</strong> and the Musanze final payment.</p><table><thead><tr><th>Cost centre</th><th>Income (RWF)</th><th>Expenses (RWF)</th></tr></thead><tbody><tr><td>Projects</td><td>51,050,000</td><td>11,640,000</td></tr><tr><td>Farm</td><td>4,170,000</td><td>798,000</td></tr><tr><td>Office</td><td>–</td><td>636,000</td></tr></tbody></table><p>Full figures in the attached PDF.</p>',
  });
  await dir.post('/reports/requests', {
    title: 'December harvest forecast',
    description: '<p>Expected tomato, pepper and cucumber volumes per week for December.</p>',
    assigneeId: U.farm,
    dueDate: ahead(5),
  });
  await dir.post('/reports/requests', {
    title: 'Bugesera pump options',
    description: '<p>Compare two pump options with costs and lead times.</p>',
    assigneeId: U.ops,
    dueDate: ahead(4),
  });

  // ------------------------------------------------------------ negative checks
  step('Permission checks (must be refused)');
  await tech1.expect(403, 'POST', `/requests/${reqFungicide.id}/approve`, {});
  await tech1.expect(403, 'GET', '/finance/summary');
  await tech1.expect(403, 'GET', '/payroll/employees');
  await farm.expect(403, 'GET', '/finance/transactions');
  await agro.expect(403, 'POST', '/farm/harvests', {
    greenhouseId: gh[0].id,
    quantity: 1,
    harvestDate: TODAY,
  });
  await bdm.expect(403, 'GET', '/audit');
  await oa.expect(403, 'POST', `/requests/${reqFungicide.id}/approve`, {});
  await tech2.expect(403, 'POST', '/finance/transactions', {
    direction: 'out',
    transactionDate: TODAY,
    amount: 1000,
    categoryId: cat('Other'),
    costCentreType: 'office',
  });
  await ops.expect(403, 'PATCH', `/roles/${1}`, { name: 'x' });

  step('Read-back of dashboards, books and reports for every role');
  for (const s of [dir, oa, bdm, ops, tech1, farm, agro]) await s.get('/dashboard');
  for (const book of [
    'day-book',
    'cash-book',
    'general-ledger',
    'trial-balance',
    'income-statement',
    'cash-flow-statement',
    'budget-vs-actual',
    'loan-register',
  ]) {
    await oa.get(`/finance/books/${book}?from=${ago(60)}&to=${TODAY}`);
  }
  const reports = await dir.get('/reports');
  for (const r of reports) await dir.get(`/reports/${r.key}?from=${ago(30)}&to=${TODAY}`);
  await dir.get('/reports/departmental');
  await dir.get('/projects/profitability');
  await dir.get('/farm/overview');
  await dir.get('/crm/pipeline');

  console.log(`\nDone: ${stepCount} successful API calls.`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
