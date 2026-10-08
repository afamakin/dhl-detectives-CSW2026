import fs from "node:fs/promises";
import { getStore } from "@netlify/blobs";

const store = getStore({
  name: "dhl-detectives-csw2026",
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_API_TOKEN
});

const roster = {
  "Team Cipher": ["Kayode Adeniji","Aderonke Kuyebi","Ayodeji Okewale","Oluwatomilayo Aiyegbayo","Oluseyi Arikawe","Olanrewaju Yusuf","Olabode Olubunmi","Oluchi Ajoku"],
  "Team Enigma": ["Ololade Onishemo","Omotola Muideen","Deborah Oparinde","Emmanuel Ayomikuseyin","Moses Adeleye","Aderonke Adefeso","Bukola Kuyoro","Winifred Otu"],
  "Team Nexus": ["Tolulope Odunlami","Temitayo Bakare","Rasheedat Odebe","Adebola Yakubu","Oladipupo Afolabi","Adefisayo Adeboye","Oluwafunmilola Taylor","Blessing Nwadiolu"],
  "Team Quantum": ["Mojisola Adegboyega","Gbemisola Akeredolu","Uduak Inyang","Mosunmola Moshood","Festus Oluwatuyi","Olayinka Fasusi","Bukola Kolawole"],
  "Team Apex": ["Olayemi Olusona","Emmanuel Ademiluyi","Benjamin Aghogban","Leo Ugbogure","Omotayo Ajadi","Samuel Etim","Raphael Audu"]
};

function normalize(record) {
  const a = record?.accusation || {};
  const evidencePoints = Array.isArray(record?.results)
    ? record.results.reduce((s,r)=>s+(Number(r?.points)||0),0)
    : Number(record?.evidencePoints||0);
  const who = Number(a.whoPoints ?? a.who ?? 0)||0;
  const where = Number(a.wherePoints ?? a.where ?? 0)||0;
  const when = Number(a.whenPoints ?? a.when ?? 0)||0;
  const why = Number(a.whyPoints ?? a.why ?? 0)||0;
  const bonus = Number(record?.bonus||0);
  return {
    team: record?.team || "",
    player: record?.player || "",
    completed: !!record?.completed,
    evidencePoints,
    whoPoints: who,
    wherePoints: where,
    whenPoints: when,
    whyPoints: why,
    bonus,
    total: Number(record?.total ?? (evidencePoints+bonus+who+where+when+why))||0,
    completedAt: record?.completedAt || ""
  };
}

const listed = await store.list({prefix:"player/"});
const map = new Map();
for (const item of listed.blobs || []) {
  const raw = await store.get(item.key, {type:"json"});
  const row = normalize(raw);
  if (row.team && row.player) map.set(row.team+"|"+row.player,row);
}

const rows=[];
for (const [team,players] of Object.entries(roster)) {
  for (const player of players) {
    rows.push(map.get(team+"|"+player) || {
      team,player,completed:false,evidencePoints:0,whoPoints:0,wherePoints:0,whenPoints:0,whyPoints:0,bonus:0,total:0,completedAt:""
    });
  }
}

const teamSummary=Object.keys(roster).map(team=>{
  const rs=rows.filter(r=>r.team===team);
  const completed=rs.filter(r=>r.completed);
  const total=rs.reduce((s,r)=>s+r.total,0);
  const maxPossible=completed.length*20;
  return {team,completedPlayers:completed.length,totalPlayers:rs.length,total,average:completed.length?total/completed.length:0,maxPossible,percentage:maxPossible?total/maxPossible*100:0};
}).sort((a,b)=>b.total-a.total);

const payload={generatedAt:new Date().toISOString(),rows,teamSummary};
await fs.mkdir("results-site/data",{recursive:true});
await fs.writeFile("results-site/data/results.json",JSON.stringify(payload,null,2));
console.log(`Exported ${rows.length} rostered player rows and ${teamSummary.length} teams.`);
