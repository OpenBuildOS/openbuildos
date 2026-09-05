import assert from "node:assert/strict";
import test from "node:test";

import {
  computeDocumentGraphEvents,
  computeDocumentVersionGraphEvents,
  toTimestampLike,
  type ComputeDocumentGraphEventsInput,
  type ComputeDocumentVersionGraphEventsInput,
  type DocumentDocLike,
  type DocumentVersionDocLike,
} from "./documentGraphEvents";

const VERSION_REF = { wid: "ws1", pid: "p1", versionId: "v1" };
const DOC_REF = { wid: "ws1", pid: "p1", documentId: "d1" };
const FALLBACK = { seconds: 1000, nanoseconds: 0 };

/** Firestore `Timestamp` z Admin SDK má právě tyhle dvě vlastnosti. */
function ts(seconds: number) {
  return { seconds, nanoseconds: 0 };
}

function versionInput(
  before: DocumentVersionDocLike | undefined,
  after: DocumentVersionDocLike | undefined,
  overrides: Partial<ComputeDocumentVersionGraphEventsInput> = {}
): ComputeDocumentVersionGraphEventsInput {
  return {
    before,
    after,
    ref: VERSION_REF,
    eventBaseId: "evt-1",
    entityRevMicros: 42,
    fallbackOccurredAt: FALLBACK,
    ...overrides,
  };
}

function docInput(
  before: DocumentDocLike | undefined,
  after: DocumentDocLike | undefined,
  overrides: Partial<ComputeDocumentGraphEventsInput> = {}
): ComputeDocumentGraphEventsInput {
  return {
    before,
    after,
    ref: DOC_REF,
    eventBaseId: "evt-1",
    entityRevMicros: 42,
    fallbackOccurredAt: FALLBACK,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// documentVersions
// ---------------------------------------------------------------------------

test("nahraná revize → created na revizi + version_added na dokumentu", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(undefined, {
      documentId: "d1",
      versionLabel: "R01",
      status: "draft",
      uploadedBy: "user-a",
      uploadedAt: ts(500),
    })
  );
  assert.equal(events.length, 2);

  assert.equal(events[0].action, "created");
  assert.equal(events[0].eventId, "evt-1-created");
  assert.deepEqual(events[0].entity, {
    wid: "ws1",
    pid: "p1",
    type: "document_version",
    documentId: "d1",
    versionId: "v1",
  });
  assert.equal(events[0].label, "R01");
  assert.equal(events[0].actor, "user-a");
  assert.deepEqual(events[0].occurredAt, { seconds: 500, nanoseconds: 0 });

  assert.equal(events[1].action, "version_added");
  assert.equal(events[1].eventId, "evt-1-version_added");
  assert.deepEqual(events[1].entity, { wid: "ws1", pid: "p1", type: "document", documentId: "d1" });
  if (events[1].action === "version_added") {
    assert.deepEqual(events[1].versionRef, events[0].entity);
  }
});

test("revize bez uploadedBy padá na createdBy, pak na unknown", () => {
  const withCreatedBy = computeDocumentVersionGraphEvents(
    versionInput(undefined, { documentId: "d1", versionLabel: "R01", createdBy: "user-b" })
  );
  assert.equal(withCreatedBy[0].actor, "user-b");

  const withoutAnyone = computeDocumentVersionGraphEvents(
    versionInput(undefined, { documentId: "d1", versionLabel: "R01" })
  );
  assert.equal(withoutAnyone[0].actor, "unknown");
  // Bez razítka v datech se čas bere z doručení CloudEventu, nevymýšlí se.
  assert.deepEqual(withoutAnyone[0].occurredAt, FALLBACK);
});

test("revize bez documentId nevydá nic — událost bez entity je horší než žádná", () => {
  assert.deepEqual(computeDocumentVersionGraphEvents(versionInput(undefined, { versionLabel: "R01" })), []);
});

test("tvrdé smazání revize → deleted s tombstone ve tvaru label + stav a čas doručení", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput({ documentId: "d1", versionLabel: "R02", status: "approved", updatedAt: ts(10) }, undefined)
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "deleted");
  assert.equal(events[0].actor, "unknown");
  assert.deepEqual(events[0].occurredAt, FALLBACK);
  if (events[0].action === "deleted") {
    assert.equal(events[0].tombstone.label, "R02 (approved)");
  }
});

test("smazání revize beze jména → tombstone padá na fallback popisek", () => {
  const events = computeDocumentVersionGraphEvents(versionInput({ documentId: "d1" }, undefined));
  assert.equal(events[0].action, "deleted");
  if (events[0].action === "deleted") {
    assert.equal(events[0].tombstone.label, "(bez názvu)");
  }
});

test("žádná změna na revizi → žádné události", () => {
  const version: DocumentVersionDocLike = {
    documentId: "d1",
    versionLabel: "R01",
    status: "draft",
    updatedAt: ts(20),
  };
  assert.deepEqual(computeDocumentVersionGraphEvents(versionInput(version, { ...version })), []);
});

test("změna stavu revize → status_changed s ID, ne s labelem", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "under_review" },
      { documentId: "d1", versionLabel: "R01", status: "approved", updatedAt: ts(30) }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "status_changed");
  assert.equal(events[0].eventId, "evt-1-status_changed");
  if (events[0].action === "status_changed") {
    assert.equal(events[0].fromStatusId, "under_review");
    assert.equal(events[0].toStatusId, "approved");
  }
});

test("supersede i ruční oprava evidence jdou touž cestou (status_changed)", () => {
  const corrected = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "rejected", statusChangedAt: ts(5) },
      {
        documentId: "d1",
        versionLabel: "R01",
        status: "approved",
        statusChangedAt: ts(40),
        statusChangedBy: "user-fix",
        updatedAt: ts(40),
      }
    )
  );
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].action, "status_changed");
  // Ruční opravu podepisuje ten, kdo ji provedl.
  assert.equal(corrected[0].actor, "user-fix");
});

test("statusChangedBy z minulé opravy nepodepisuje pozdější změny", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "approved", statusChangedAt: ts(5), statusChangedBy: "user-fix" },
      {
        documentId: "d1",
        versionLabel: "R01",
        status: "superseded",
        statusChangedAt: ts(5),
        statusChangedBy: "user-fix",
        updatedAt: ts(60),
      }
    )
  );
  assert.equal(events[0].actor, "unknown");
});

test("nové rozhodnutí schvalovatele → decision_recorded, actor je rozhodující", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "under_review" },
      {
        documentId: "d1",
        versionLabel: "R01",
        status: "under_review",
        approvals: { "user-a": { decision: "approved_with_comments", at: "2026-09-05T10:00:00.000Z", comment: "s výhradou" } },
        reviewedAt: ts(70),
        reviewedBy: "user-a",
        updatedAt: ts(70),
      }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "decision_recorded");
  assert.equal(events[0].eventId, "evt-1-decision_recorded-0");
  assert.equal(events[0].actor, "user-a");
  if (events[0].action === "decision_recorded") {
    assert.equal(events[0].decision, "approved_with_comments");
    assert.equal(events[0].byPrincipal, "user-a");
    assert.equal(events[0].comment, "s výhradou");
  }
});

test("dvě nová rozhodnutí v jednom zápisu → dvě události s odlišným eventId", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "under_review", approvals: {} },
      {
        documentId: "d1",
        versionLabel: "R01",
        status: "approved",
        approvals: {
          "user-b": { decision: "approved", at: "2026-09-05T10:00:00.000Z" },
          "user-a": { decision: "approved", at: "2026-09-05T10:00:00.000Z" },
        },
        updatedAt: ts(80),
      }
    )
  );
  const ids = events.map((event) => event.eventId);
  assert.equal(new Set(ids).size, ids.length, "eventId se nesmí opakovat");
  const decisions = events.filter((event) => event.action === "decision_recorded");
  assert.equal(decisions.length, 2);
  // Setříděno kvůli determinismu při opakovaném doručení téhož zápisu.
  assert.deepEqual(
    decisions.map((event) => (event.action === "decision_recorded" ? event.byPrincipal : "")),
    ["user-a", "user-b"]
  );
  assert.deepEqual(ids.includes("evt-1-status_changed"), true);
});

test("už zaznamenané rozhodnutí druhou událost nevydá", () => {
  const approvals = { "user-a": { decision: "approved", at: "2026-09-05T10:00:00.000Z" } };
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "under_review", approvals },
      { documentId: "d1", versionLabel: "R01", status: "approved", approvals, updatedAt: ts(90) }
    )
  );
  assert.deepEqual(
    events.map((event) => event.action),
    ["status_changed"]
  );
});

test("rozhodnutí bez komentáře komentář NEZAPISUJE (Firestore odmítá undefined)", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "under_review" },
      {
        documentId: "d1",
        versionLabel: "R01",
        status: "under_review",
        approvals: { "user-a": { decision: "approved", at: "2026-09-05T10:00:00.000Z" } },
        updatedAt: ts(95),
      }
    )
  );
  assert.equal(Object.prototype.hasOwnProperty.call(events[0], "comment"), false);
});

// ── kód vhodnosti (F3): druhá osa vedle stavu ──────────────────────────────

test("vydání pro provedení → suitability_changed info → construction", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R02", status: "approved", suitability: "info" },
      {
        documentId: "d1",
        versionLabel: "R02",
        status: "approved",
        suitability: "construction",
        updatedAt: ts(100),
        suitabilityChangedAt: ts(100),
        suitabilityChangedBy: "user-tdi",
      }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "suitability_changed");
  assert.equal(events[0].eventId, "evt-1-suitability_changed");
  assert.equal(events[0].label, "R02");
  if (events[0].action === "suitability_changed") {
    assert.equal(events[0].from, "info");
    assert.equal(events[0].to, "construction");
  }
});

/**
 * Zrušení vydání musí být v záznamu stejně vidět jako vydání samo: „podle téhle
 * revize se už stavět nesmí" je tvrzení, které někdo na stavbě potřebuje doložit.
 */
test("zrušení vydání → suitability_changed construction → info", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R02", suitability: "construction" },
      { documentId: "d1", versionLabel: "R02", suitability: "info", updatedAt: ts(120) }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "suitability_changed");
  if (events[0].action === "suitability_changed") {
    assert.equal(events[0].from, "construction");
    assert.equal(events[0].to, "info");
  }
});

/**
 * 🔴 `scripts/backfill-suitability.mjs` dopisuje chybějícím revizím `info`.
 * Chybějící pole SE ČTE jako `info`, takže je to no-op — kdyby událost vydal,
 * měla by každá revize ve stavbě v Historii řádek o tom, že se nic nestalo.
 */
test("doběh dopisující `info` chybějícímu poli žádnou událost nevydá", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R02", status: "approved" },
      {
        documentId: "d1",
        versionLabel: "R02",
        status: "approved",
        suitability: "info",
        updatedAt: ts(140),
        suitabilityChangedAt: ts(140),
        suitabilityChangedBy: "backfill",
      }
    )
  );
  assert.deepEqual(events, []);
});

/**
 * Stopa vhodnosti má přednost před `statusChangedBy`/`reviewedBy`, které
 * v datech ZŮSTÁVAJÍ po starším rozhodování. Bez přednosti by se nejsilnější
 * tvrzení v modulu připsalo tomu, kdo naposledy schvaloval.
 */
test("actor i occurredAt bere vydání ze své vlastní stopy, ne ze starého schválení", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      {
        documentId: "d1",
        versionLabel: "R02",
        status: "approved",
        statusChangedAt: ts(5),
        statusChangedBy: "user-approver",
        reviewedAt: ts(5),
        reviewedBy: "user-reviewer",
      },
      {
        documentId: "d1",
        versionLabel: "R02",
        status: "approved",
        statusChangedAt: ts(5),
        statusChangedBy: "user-approver",
        reviewedAt: ts(5),
        reviewedBy: "user-reviewer",
        suitability: "construction",
        updatedAt: ts(900),
        suitabilityChangedAt: ts(777),
        suitabilityChangedBy: "user-tdi",
      }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "user-tdi");
  assert.deepEqual(events[0].occurredAt, ts(777));
});

/** Bez stopy (starší data, ruční zásah) se událost nevymýšlí — padá na fallback. */
test("vydání bez stopy → actor unknown a čas ze společného razítka", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R02" },
      { documentId: "d1", versionLabel: "R02", suitability: "construction", updatedAt: ts(300) }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "unknown");
  assert.deepEqual(events[0].occurredAt, ts(300));
});

test("vydání bez jakéhokoli razítka padá na čas doručení", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R02" },
      { documentId: "d1", versionLabel: "R02", suitability: "construction" }
    )
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].occurredAt, FALLBACK);
});

test("přejmenování revize → renamed", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R02", status: "draft" },
      { documentId: "d1", versionLabel: "R2.1", status: "draft", updatedAt: ts(100) }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "renamed");
  if (events[0].action === "renamed") {
    assert.equal(events[0].fromLabel, "R02");
    assert.equal(events[0].toLabel, "R2.1");
  }
});

test("přesun revize mezi oficiální a interní dokumentací → scope_changed", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", scope: "company_internal", ownerCompanyId: "c1" },
      { documentId: "d1", versionLabel: "R01", scope: "project_official", updatedAt: ts(110) }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "scope_changed");
  if (events[0].action === "scope_changed") {
    assert.equal(events[0].fromScope, "company_internal");
    assert.equal(events[0].toScope, "project_official");
  }
});

// ── viditelnost (§3.6) ──────────────────────────────────────────────────────

test("oficiální revize je viditelná celé stavbě", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(undefined, { documentId: "d1", versionLabel: "R01", scope: "project_official" })
  );
  assert.deepEqual(events[0].vis, { visibility: "" });
});

test("revize bez scope (legacy) platí za oficiální", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(undefined, { documentId: "d1", versionLabel: "R01" })
  );
  assert.deepEqual(events[0].vis, { visibility: "" });
});

test("interní revize firmy vidí jen ta firma", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(undefined, {
      documentId: "d1",
      versionLabel: "R01",
      scope: "company_internal",
      ownerCompanyId: "company-1",
    })
  );
  assert.deepEqual(events[0].vis, { visibility: "company-1", ownerCompanyId: "company-1" });
});

test("🔴 interní revize BEZ ownerCompanyId je fail-closed — nepřečte ji nikdo", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(undefined, { documentId: "d1", versionLabel: "Tajné", scope: "company_internal" })
  );
  assert.deepEqual(events[0].vis, { visibility: "__internal_unreadable__" });
});

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

test("založený dokument → created s názvem a autorem", () => {
  const events = computeDocumentGraphEvents(
    docInput(undefined, {
      title: "Půdorys 1NP",
      status: "active",
      currentVersionId: "v1",
      createdBy: "user-a",
      createdAt: ts(200),
    })
  );
  assert.equal(events.length, 1, "vznik nevydá i current_version_changed");
  assert.equal(events[0].action, "created");
  assert.deepEqual(events[0].entity, { wid: "ws1", pid: "p1", type: "document", documentId: "d1" });
  assert.equal(events[0].label, "Půdorys 1NP");
  assert.equal(events[0].actor, "user-a");
});

test("dokument do koše → deleted s tombstone a autorem z deletedBy", () => {
  const events = computeDocumentGraphEvents(
    docInput(
      { title: "Půdorys 1NP", status: "active" },
      { title: "Půdorys 1NP", status: "active", deletedAt: ts(300), deletedBy: "user-c", updatedAt: ts(300) }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "deleted");
  assert.equal(events[0].actor, "user-c");
  if (events[0].action === "deleted") {
    assert.equal(events[0].tombstone.label, "Půdorys 1NP");
  }
});

test("návrat z koše → restored", () => {
  const events = computeDocumentGraphEvents(
    docInput(
      { title: "Půdorys 1NP", deletedAt: ts(300), deletedBy: "user-c" },
      { title: "Půdorys 1NP", deletedAt: null, deletedBy: null, updatedAt: ts(310) }
    )
  );
  assert.deepEqual(
    events.map((event) => event.action),
    ["restored"]
  );
});

test("tvrdé smazání dokumentu (vysypání koše) → deleted", () => {
  const events = computeDocumentGraphEvents(docInput({ title: "Půdorys 1NP" }, undefined));
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "deleted");
  assert.deepEqual(events[0].occurredAt, FALLBACK);
});

test("přejmenování dokumentu → renamed, autora bere z nové položky identityChanges", () => {
  const events = computeDocumentGraphEvents(
    docInput(
      { title: "Půdorys", identityChanges: [] },
      {
        title: "Půdorys 1NP",
        updatedAt: ts(400),
        identityChanges: [{ changedAt: "2026-09-05T10:00:00.000Z", changedBy: "user-d" }],
      }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "renamed");
  assert.equal(events[0].actor, "user-d");
  if (events[0].action === "renamed") {
    assert.equal(events[0].fromLabel, "Půdorys");
    assert.equal(events[0].toLabel, "Půdorys 1NP");
  }
});

test("archivace dokumentu → status_changed", () => {
  const events = computeDocumentGraphEvents(
    docInput({ title: "X", status: "active" }, { title: "X", status: "archived", updatedAt: ts(500) })
  );
  assert.deepEqual(
    events.map((event) => event.action),
    ["status_changed"]
  );
});

test("změna platné revize → current_version_changed s oběma stranami", () => {
  const events = computeDocumentGraphEvents(
    docInput(
      { title: "X", currentVersionId: "v1" },
      { title: "X", currentVersionId: "v2", updatedAt: ts(600) }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "current_version_changed");
  assert.equal(events[0].eventId, "evt-1-current_version_changed");
  // Ukazatel dokumentu nenese autora — kdo rozhodoval, je vidět na událostech revize.
  assert.equal(events[0].actor, "unknown");
  if (events[0].action === "current_version_changed") {
    assert.equal(events[0].fromVersionId, "v1");
    assert.equal(events[0].toVersionId, "v2");
  }
});

test("ztráta platné revize → current_version_changed jen s fromVersionId", () => {
  const events = computeDocumentGraphEvents(
    docInput({ title: "X", currentVersionId: "v1" }, { title: "X", currentVersionId: null, updatedAt: ts(610) })
  );
  assert.equal(events[0].action, "current_version_changed");
  // Firestore odmítá `undefined` — chybějící strana se VYNECHÁVÁ, nepíše se null.
  assert.equal(Object.prototype.hasOwnProperty.call(events[0], "toVersionId"), false);
  if (events[0].action === "current_version_changed") {
    assert.equal(events[0].fromVersionId, "v1");
  }
});

test("žádná změna na dokumentu → žádné události", () => {
  const record: DocumentDocLike = { title: "X", status: "active", currentVersionId: "v1", updatedAt: ts(700) };
  assert.deepEqual(computeDocumentGraphEvents(docInput(record, { ...record })), []);
});

test("interní dokument firmy je fail-closed stejně jako revize", () => {
  const withCompany = computeDocumentGraphEvents(
    docInput(undefined, { title: "Interní", scope: "company_internal", ownerCompanyId: "c9" })
  );
  assert.deepEqual(withCompany[0].vis, { visibility: "c9", ownerCompanyId: "c9" });

  const withoutCompany = computeDocumentGraphEvents(
    docInput(undefined, { title: "Interní", scope: "company_internal" })
  );
  assert.deepEqual(withoutCompany[0].vis, { visibility: "__internal_unreadable__" });
});

// ---------------------------------------------------------------------------
// časová razítka
// ---------------------------------------------------------------------------

test("toTimestampLike umí Timestamp, Date, ISO i epochu; jinak fallback", () => {
  assert.deepEqual(toTimestampLike({ seconds: 5, nanoseconds: 7 }, FALLBACK), { seconds: 5, nanoseconds: 7 });
  assert.deepEqual(toTimestampLike({ _seconds: 5, _nanoseconds: 7 }, FALLBACK), { seconds: 5, nanoseconds: 7 });
  assert.deepEqual(toTimestampLike(new Date(2000), FALLBACK), { seconds: 2, nanoseconds: 0 });
  assert.deepEqual(toTimestampLike("1970-01-01T00:00:03.000Z", FALLBACK), { seconds: 3, nanoseconds: 0 });
  assert.deepEqual(toTimestampLike(4000, FALLBACK), { seconds: 4, nanoseconds: 0 });
  assert.deepEqual(toTimestampLike("nesmysl", FALLBACK), FALLBACK);
  assert.deepEqual(toTimestampLike(undefined, FALLBACK), FALLBACK);
  assert.deepEqual(toTimestampLike(null, FALLBACK), FALLBACK);
});

test("razítko z dat má přednost před časem doručení", () => {
  const events = computeDocumentVersionGraphEvents(
    versionInput(
      { documentId: "d1", versionLabel: "R01", status: "draft" },
      { documentId: "d1", versionLabel: "R01", status: "under_review", updatedAt: ts(12345) }
    )
  );
  assert.deepEqual(events[0].occurredAt, { seconds: 12345, nanoseconds: 0 });
});
