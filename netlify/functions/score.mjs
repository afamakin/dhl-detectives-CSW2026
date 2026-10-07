// netlify/functions/score.mjs
// Server-side game engine for DHL Detectives – Customer Service Week 2026.
//
// The answer key, clues and accusation scoring live ONLY in this file, so they
// never reach the browser until a player has locked in their own answer.
//
//   GET  /.netlify/functions/score
//        -> { scores }
//
//   POST { action:"start", team, player }
//        -> begin / restart an unfinished attempt
//        -> 409 if the player has already completed the case
//
//   POST { type:"open", question, team, player }
//        -> server starts the 30s clock for a question
//
//   POST { type:"answer", question, choice, team, player }
//        -> choice = option index, or -1 for "time up"
//        -> { correct, correctIndex, clue, timedOut, scores }
//
//   POST { type:"final", who, where, when, why, team, player }
//        -> { evidencePoints, bonus, total, breakdown, scores }
//
//   POST { action:"reset", team, player, token }
//        -> permanently deletes that player's stored attempt
//        -> recalculates all team totals
//        -> can be used repeatedly when the RESET_TOKEN is valid
//
// IMPORTANT:
// RESET_TOKEN must be stored as a Netlify Environment Variable.
// NEVER put the actual token value in this file.
//
// (every POST also carries { team, player })

import { getStore } from "@netlify/blobs";

/* ------------------------------ GAME DATA ------------------------------ */

const ROSTER = {
  "Team Cipher": [
    "Kayode Adeniji",
    "Aderonke Kuyebi",
    "Ayodeji Okewale",
    "Oluwatomilayo Aiyegbayo",
    "Oluseyi Arikawe",
    "Olanrewaju Yusuf",
    "Olabode Olubunmi",
    "Oluchi Ajoku"
  ],

  "Team Enigma": [
    "Ololade Onishemo",
    "Omotola Muideen",
    "Deborah Oparinde",
    "Emmanuel Ayomikuseyin",
    "Moses Adeleye",
    "Aderonke Adefeso",
    "Bukola Kuyoro",
    "Winifred Otu"
  ],

  "Team Nexus": [
    "Tolulope Odunlami",
    "Temitayo Bakare",
    "Rasheedat Odebe",
    "Adebola Yakubu",
    "Oladipupo Afolabi",
    "Adefisayo Adeboye",
    "Oluwafunmilola Taylor",
    "Blessing Nwadiolu"
  ],

  "Team Quantum": [
    "Mojisola Adegboyega",
    "Gbemisola Akeredolu",
    "Uduak Inyang",
    "Mosunmola Moshood",
    "Festus Oluwatuyi",
    "Olayinka Fasusi",
    "Bukola Kolawole"
  ],

  "Team Apex": [
    "Olayemi Olusona",
    "Emmanuel Ademiluyi",
    "Benjamin Aghogban",
    "Leo Ugbogure",
    "Omotayo Ajadi",
    "Samuel Etim",
    "Raphael Audu"
  ],
};

// Index of the correct option for each of the 10 case files.
const ANSWERS = [1, 1, 2, 1, 1, 0, 1, 2, 0, 2];

// Number of answer options per case file.
// Case File 10 has five suspects.
const OPTION_COUNTS = [4, 4, 4, 4, 4, 4, 4, 4, 4, 5];

const CLUES = [
  [
    "EVIDENCE 01 • THE TIME WINDOW",
    "The award was confirmed on the display stand at 2:00 p.m. and was missing by 2:30 p.m. The disappearance happened inside that window."
  ],
  [
    "EVIDENCE 02 • THE 2:10 TIMESTAMP",
    "Chika was recorded in the Decorations Area at approximately 2:10 p.m., inside the disappearance window."
  ],
  [
    "EVIDENCE 03 • THE EVENT ROLE",
    "Chika's HR / Events Coordinator role gives her a legitimate reason to handle Customer Service Week decorations."
  ],
  [
    "EVIDENCE 04 • THE RED EVENT FILE",
    "The red event file connects Chika to the event-preparation materials, but one clue alone is not proof of guilt."
  ],
  [
    "EVIDENCE 05 • THE 2:20 SIGHTING",
    "A person was seen with event materials around 2:20 p.m. Compare the role, location and timing with the suspect files."
  ],
  [
    "EVIDENCE 06 • THE SURPRISE PLAN",
    "A Customer Service Week surprise was being prepared, giving the award a legitimate reason to be temporarily hidden."
  ],
  [
    "EVIDENCE 07 • ACCESS OF OTHER SUSPECTS",
    "Verified access helps eliminate suspects who could not reasonably have been in the relevant area."
  ],
  [
    "EVIDENCE 08 • THE DECORATIONS BOX",
    "The physical evidence points to the Decorations Box as the award's temporary hiding place."
  ],
  [
    "EVIDENCE 09 • NO THEFT / MOTIVE",
    "The award was deliberately hidden as part of the Customer Service Week surprise, not stolen for personal gain."
  ],
  [
    "EVIDENCE 10 • CASE CLOSED",
    "Chika moved the Customer Service Award to the Decorations Box as part of the Customer Service Week surprise."
  ],
];

// Final accusation: correct value and points for each part (max 10).
const ACCUSATION = {
  who: {
    answer: "Chika",
    points: 3
  },

  where: {
    answer: "Decorations Box",
    points: 2
  },

  when: {
    answer: "2:00–3:00 p.m.",
    points: 2
  },

  why: {
    answer: "Customer Service Week surprise",
    points: 3
  },
};

const QUESTION_COUNT = ANSWERS.length;
const QUESTION_SECONDS = 30;
const GRACE_SECONDS = 6;

/* ------------------------------- HELPERS ------------------------------- */

const PLAYER_PREFIX = "player/";
const TOTALS_KEY = "totals";

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: HEADERS
  });

const store = () =>
  getStore({
    name: "dhl-detectives-csw2026",
    consistency: "strong"
  });

const playerKey = (team, player) =>
  `${PLAYER_PREFIX}${team}|${player}`;

const emptyScores = () =>
  Object.fromEntries(
    Object.keys(ROSTER).map((team) => [team, 0])
  );

const evidencePoints = (rec) =>
  Object.values(rec.results || {}).reduce(
    (sum, result) => sum + (result.points || 0),
    0
  );

const playerTotal = (rec) =>
  evidencePoints(rec) + (rec.bonus || 0);

async function recomputeTotals(s) {
  const scores = emptyScores();

  const { blobs } = await s.list({
    prefix: PLAYER_PREFIX
  });

  const records = await Promise.all(
    blobs.map((blob) =>
      s.get(blob.key, {
        type: "json"
      })
    )
  );

  for (const rec of records) {
    if (rec && scores[rec.team] !== undefined) {
      scores[rec.team] += playerTotal(rec);
    }
  }

  await s.setJSON(TOTALS_KEY, scores);

  return scores;
}

async function readTotals(s) {
  const cached = await s.get(TOTALS_KEY, {
    type: "json"
  });

  return cached
    ? { ...emptyScores(), ...cached }
    : recomputeTotals(s);
}

const answerPayload = (q, result, scores) => ({
  ok: true,
  correct: result.points === 1,
  timedOut: result.choice === -1,
  correctIndex: ANSWERS[q],
  clue: CLUES[q],
  scores
});

/* ------------------------------- HANDLER ------------------------------- */

export default async (req) => {
  try {
    const s = store();

    /* ------------------------------- GET ------------------------------- */

    if (req.method === "GET") {
      return json({
        scores: await readTotals(s)
      });
    }

    /* ---------------------------- METHOD CHECK ------------------------- */

    if (req.method !== "POST") {
      return json(
        { error: "Method not allowed" },
        405
      );
    }

    /* ---------------------------- READ BODY ---------------------------- */

    let body;

    try {
      body = await req.json();
    } catch {
      return json(
        { error: "Invalid JSON" },
        400
      );
    }

    const {
      team,
      player,
      action,
      type
    } = body || {};

    /* -------------------------- ROSTER CHECK --------------------------- */

    if (
      !ROSTER[team] ||
      !ROSTER[team].includes(player)
    ) {
      return json(
        { error: "Unknown team or player" },
        400
      );
    }

    const key = playerKey(team, player);

    /*
      Read the current player record.

      This is deliberately done BEFORE the reset check so that the reset
      response can tell us whether a stored record actually existed.
    */
    const existing = await s.get(key, {
      type: "json"
    });

    /* ------------------------------ RESET ------------------------------ */

    /*
      ADMIN RESET

      This can be used whenever you need to reset a player for testing.

      Example:
      {
        "action": "reset",
        "team": "Team Nexus",
        "player": "Adebola Yakubu",
        "token": "YOUR_RESET_TOKEN"
      }

      The player record is deleted completely.

      Their previous evidence answers, score, accusation and completed
      status are therefore removed.

      Team totals are then rebuilt from every remaining player record.

      Because the record is deleted rather than merely marked incomplete,
      the same player can be reset again in the future.
    */

    if (action === "reset") {
      if (
        !process.env.RESET_TOKEN ||
        body.token !== process.env.RESET_TOKEN
      ) {
        return json(
          { error: "Unauthorized" },
          401
        );
      }

      await s.delete(key);

      const scores = await recomputeTotals(s);

      return json({
        ok: true,
        reset: `${team}|${player}`,
        existed: Boolean(existing),
        scores
      });
    }

    /* ---------------------- COMPLETED PLAYER CHECK --------------------- */

    /*
      A completed case is final unless an authorised RESET request is used.
    */

    if (existing?.completed) {
      return json(
        {
          completed: true,
          error: "Case already completed",
          scores: await readTotals(s)
        },
        409
      );
    }

    /* ------------------------------- START ----------------------------- */

    /*
      START:
      Creates a fresh attempt for the player.

      This works normally when there is no record, or when an unfinished
      attempt exists.
    */

    if (action === "start") {
      await s.setJSON(key, {
        team,
        player,
        opened: {},
        results: {},
        bonus: 0,
        completed: false,
        startedAt: new Date().toISOString()
      });

      return json({
        ok: true,
        scores: await recomputeTotals(s)
      });
    }

    /* ------------------------- NOT STARTED CHECK ----------------------- */

    if (!existing) {
      return json(
        {
          error: "Case not started",
          code: "not_started"
        },
        409
      );
    }

    const rec = existing;

    /* ------------------------------- OPEN ------------------------------ */

    if (type === "open") {
      const q = Number(body.question);

      if (
        !Number.isInteger(q) ||
        q < 0 ||
        q >= QUESTION_COUNT
      ) {
        return json(
          { error: "Invalid question" },
          400
        );
      }

      if (
        !rec.results[q] &&
        !rec.opened[q]
      ) {
        rec.opened[q] = Date.now();

        await s.setJSON(key, rec);
      }

      return json({
        ok: true
      });
    }

    /* ------------------------------ ANSWER ----------------------------- */

    if (type === "answer") {
      const q = Number(body.question);
      const choice = Number(body.choice);

      if (
        !Number.isInteger(q) ||
        q < 0 ||
        q >= QUESTION_COUNT
      ) {
        return json(
          { error: "Invalid question" },
          400
        );
      }

      if (
        !Number.isInteger(choice) ||
        choice < -1 ||
        choice >= OPTION_COUNTS[q]
      ) {
        return json(
          { error: "Invalid choice" },
          400
        );
      }

      /*
        Already locked:
        return the original stored result and do not change anything.
      */

      if (rec.results[q]) {
        return json(
          answerPayload(
            q,
            rec.results[q],
            await readTotals(s)
          )
        );
      }

      if (!rec.opened[q]) {
        return json(
          {
            error: "not_opened"
          },
          409
        );
      }

      const elapsed =
        (Date.now() - rec.opened[q]) / 1000;

      const timedOut =
        choice === -1 ||
        elapsed > QUESTION_SECONDS + GRACE_SECONDS;

      const result = {
        choice: timedOut ? -1 : choice,
        points:
          !timedOut &&
          choice === ANSWERS[q]
            ? 1
            : 0
      };

      rec.results[q] = result;

      await s.setJSON(key, rec);

      return json(
        answerPayload(
          q,
          result,
          await recomputeTotals(s)
        )
      );
    }

    /* ------------------------------- FINAL ----------------------------- */

    if (type === "final") {
      if (
        Object.keys(rec.results).length <
        QUESTION_COUNT
      ) {
        return json(
          {
            error:
              "Complete all 10 case files before the final accusation"
          },
          400
        );
      }

      const breakdown = {};
      let bonus = 0;

      for (const [field, rule] of Object.entries(ACCUSATION)) {
        breakdown[field] =
          body[field] === rule.answer;

        if (breakdown[field]) {
          bonus += rule.points;
        }
      }

      rec.bonus = bonus;

      rec.accusation = {
        who: body.who,
        where: body.where,
        when: body.when,
        why: body.why
      };

      rec.completed = true;

      rec.completedAt =
        new Date().toISOString();

      await s.setJSON(key, rec);

      const evidence =
        evidencePoints(rec);

      return json({
        ok: true,
        evidencePoints: evidence,
        bonus,
        total: evidence + bonus,
        breakdown,
        scores: await recomputeTotals(s)
      });
    }

    /* --------------------------- UNKNOWN REQUEST ----------------------- */

    return json(
      {
        error: "Unknown request type"
      },
      400
    );

  } catch (err) {
    console.error(
      "score function error:",
      err
    );

    return json(
      {
        error: "Server error"
      },
      500
    );
  }
};
