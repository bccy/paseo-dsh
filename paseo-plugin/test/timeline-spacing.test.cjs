require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  LANGUAGE_DEFAULTS,
  TIMELINE_STYLE_DEFAULTS,
  TIMELINE_STYLE_KEYS,
  languageSettings,
  resolveCommandMaxHeight,
  timelineStyleSettings,
} = require("../shared/settings.ts");

const {
  DEFAULT_LOCALE,
  allText,
  currentLocale,
  getLanguageOverride,
  setLanguageOverride,
  setLocale,
  subscribeLocale,
} = require("../client/locale.ts");

test("TIMELINE_STYLE_DEFAULTS mirrors schema defaults and preserves fork layout", () => {
  const defaults = timelineStyleSettings.schema.parse({});
  assert.deepEqual(
    TIMELINE_STYLE_DEFAULTS,
    {
      rowMarginY: 0,
      toolRowPaddingY: 0,
      toolRowMinHeight: 24,
      toolRowGap: 6,
      commandMaxHeightRatio: 0.25,
      commandMinHeight: 150,
    },
    "defaults must keep the fork's tokens.ts spacing",
  );
  assert.deepEqual(TIMELINE_STYLE_DEFAULTS, defaults, "TIMELINE_STYLE_DEFAULTS must mirror the schema");
  assert.deepEqual(
    [...TIMELINE_STYLE_KEYS].sort(),
    Object.keys(defaults).sort(),
    "TIMELINE_STYLE_KEYS must cover every schema field exactly once",
  );
  assert.equal(timelineStyleSettings.id, "timeline-style");
  assert.equal(timelineStyleSettings.scope, "host");
  assert.equal(timelineStyleSettings.version, 5);
});

test("timelineStyleSettings schema enforces numeric bounds", () => {
  assert.throws(() => timelineStyleSettings.schema.parse({ rowMarginY: -17 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ rowMarginY: 25 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ toolRowPaddingY: -1 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ toolRowPaddingY: 13 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ toolRowMinHeight: 11 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ toolRowMinHeight: 65 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ toolRowGap: -1 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ toolRowGap: 25 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ commandMaxHeightRatio: 0.09 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ commandMaxHeightRatio: 0.61 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ commandMinHeight: 59 }));
  assert.throws(() => timelineStyleSettings.schema.parse({ commandMinHeight: 361 }));
});

test("v1-v5 migrate collapses legacy margin fields and falls back to fork default 0", () => {
  assert.deepEqual(
    timelineStyleSettings.migrate(
      {
        rowMarginY: 2,
        toolRowMarginY: -8,
        liveRowMarginY: 8,
        liveToolRowMarginY: 4,
        liveReasoningRowMarginY: 6,
        toolRowGap: 10,
      },
      5,
    ),
    { rowMarginY: 2, toolRowGap: 10 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate(
      { toolRowMarginY: -8, liveReasoningRowMarginY: -8, liveRowMarginY: 12 },
      4,
    ),
    { rowMarginY: -8 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate(
      { toolRowMarginY: 4, liveReasoningRowMarginY: 16 },
      3,
    ),
    { rowMarginY: 4 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate({ liveRowMarginY: 8, liveToolRowMarginY: -4 }, 1),
    { rowMarginY: 8 },
  );
  assert.deepEqual(
    timelineStyleSettings.migrate({}, 1),
    { rowMarginY: 0 },
  );
  assert.equal(timelineStyleSettings.migrate(null, 1), null);
  assert.deepEqual(timelineStyleSettings.migrate([1, 2], 1), [1, 2]);
});

test("languageSettings defaults to auto and accepts only bundled locales", () => {
  assert.deepEqual(LANGUAGE_DEFAULTS, languageSettings.schema.parse({}));
  assert.deepEqual(languageSettings.schema.parse({ language: "auto" }), { language: "auto" });
  assert.deepEqual(languageSettings.schema.parse({ language: "en" }), { language: "en" });
  assert.deepEqual(languageSettings.schema.parse({ language: "zh-CN" }), { language: "zh-CN" });
  assert.throws(() => languageSettings.schema.parse({ language: "fr" }));
  assert.equal(languageSettings.id, "language");
  assert.equal(languageSettings.scope, "host");
  assert.equal(languageSettings.version, 1);
});

test("resolveCommandMaxHeight handles normal and boundary window heights", () => {
  const style = { commandMaxHeightRatio: 0.25, commandMinHeight: 150 };
  assert.equal(resolveCommandMaxHeight(style, 1200), 300);
  assert.equal(resolveCommandMaxHeight(style, 500), 150);
  assert.equal(resolveCommandMaxHeight(style, 602), 151);
  assert.equal(resolveCommandMaxHeight(style, 0), 150);
  assert.equal(resolveCommandMaxHeight(style, -400), 150);
  assert.equal(resolveCommandMaxHeight(style, Number.NaN), 150);
  assert.equal(resolveCommandMaxHeight(style, Number.POSITIVE_INFINITY), 150);
  assert.equal(resolveCommandMaxHeight(style, Number.NEGATIVE_INFINITY), 150);
});

test("client/locale language override precedence and subscriber notifications", () => {
  let notifications = 0;
  const unsubscribe = subscribeLocale(() => {
    notifications += 1;
  });
  try {
    setLanguageOverride("auto");
    setLocale(undefined);
    notifications = 0;

    assert.equal(getLanguageOverride(), "auto");
    assert.equal(currentLocale(), DEFAULT_LOCALE);

    // Relay updates effective locale when override is auto.
    setLocale("en");
    assert.equal(currentLocale(), "en");
    assert.equal(notifications, 1);

    // Repeating same effective locale does not notify.
    setLocale("en_US.UTF-8");
    assert.equal(notifications, 1);

    // Explicit override wins over relay and notifies on effective change.
    setLanguageOverride("zh-CN");
    assert.equal(getLanguageOverride(), "zh-CN");
    assert.equal(currentLocale(), "zh-CN");
    assert.equal(notifications, 2);

    // Relay changes while overridden do not alter effective locale or notify.
    setLocale("en");
    assert.equal(currentLocale(), "zh-CN");
    assert.equal(notifications, 2);

    // Clearing override with "auto" falls back to relayed locale and notifies.
    setLanguageOverride("auto");
    assert.equal(getLanguageOverride(), "auto");
    assert.equal(currentLocale(), "en");
    assert.equal(notifications, 3);

    // Unknown value clears override rather than normalizing to "en".
    setLocale("zh-CN");
    assert.equal(notifications, 4);
    setLanguageOverride("en");
    assert.equal(currentLocale(), "en");
    assert.equal(notifications, 5);
    setLanguageOverride("fr");
    assert.equal(getLanguageOverride(), "auto");
    assert.equal(currentLocale(), "zh-CN");
    assert.equal(notifications, 6);

    // Unsubscribed listener stops firing.
    unsubscribe();
    setLanguageOverride("en");
    assert.equal(notifications, 6);
  } finally {
    unsubscribe();
    setLanguageOverride("auto");
    setLocale(undefined);
  }
});

test("client/locale settings copy is symmetric across en and zh-CN", () => {
  const en = allText().en.settings;
  const zh = allText()["zh-CN"].settings;

  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.deepEqual(Object.keys(en.language).sort(), Object.keys(zh.language).sort());
  assert.deepEqual(Object.keys(en.fields).sort(), [...TIMELINE_STYLE_KEYS].sort());
  assert.deepEqual(Object.keys(zh.fields).sort(), [...TIMELINE_STYLE_KEYS].sort());
  for (const key of TIMELINE_STYLE_KEYS) {
    assert.ok(en.fields[key].label.trim().length > 0);
    assert.ok(en.fields[key].hint.trim().length > 0);
    assert.ok(zh.fields[key].label.trim().length > 0);
    assert.ok(zh.fields[key].hint.trim().length > 0);
  }
});
