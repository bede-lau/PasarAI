import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  evaluate,
  navigate,
  startBrowser,
  startMockApi,
  startWebServer,
  waitForExpression
} from "./cdp-browser.mjs";

const viewport = { width: 390, height: 844 };
let browser;
let connection;
let mockApi;
let server;

const dailySummary = {
  merchant_id: "m_kak_lina_001",
  date: "2026-07-12",
  revenue_rm: "200.00",
  cogs_rm: "127.20",
  gross_profit_rm: "72.80",
  gross_margin_pct: "36.40",
  data_completeness: {
    state: "complete",
    missing_inputs: []
  },
  top_cost_drivers: [
    { name: "Telur", contribution_rm_per_pack: "0.10" },
    { name: "Sambal + Minyak", contribution_rm_per_pack: "0.08" },
    { name: "Santan", contribution_rm_per_pack: "0.06" },
    { name: "Bekas Makanan", contribution_rm_per_pack: "0.04" }
  ],
  baseline_comparison: {
    baseline_margin_pct: "42.00",
    margin_change_percentage_points: "-5.60"
  },
  price_floor: {
    target_gross_margin_pct: "40.00",
    price_floor_rm: "5.30",
    assumption: "current_unit_cogs"
  },
  cost_stack: {
    baseline_comparison_date: "2026-07-11",
    baseline_effective_date: "2026-07-11",
    baseline_unit_cogs_rm: "2.90",
    current_unit_cogs_rm: "3.18",
    components: [
      {
        component_id: "c_egg",
        name: "Telur",
        baseline_cost_rm_per_pack: "0.45",
        current_cost_rm_per_pack: "0.55",
        change_rm_per_pack: "0.10",
        evidence_id: "receipt-sinar"
      },
      {
        component_id: "c_sambal",
        name: "Sambal + Minyak",
        baseline_cost_rm_per_pack: "0.44",
        current_cost_rm_per_pack: "0.52",
        change_rm_per_pack: "0.08",
        evidence_id: "receipt-sinar"
      },
      {
        component_id: "c_coconut",
        name: "Santan",
        baseline_cost_rm_per_pack: "0.33",
        current_cost_rm_per_pack: "0.39",
        change_rm_per_pack: "0.06",
        evidence_id: "receipt-sinar"
      },
      {
        component_id: "c_packaging",
        name: "Bekas Makanan",
        baseline_cost_rm_per_pack: "0.28",
        current_cost_rm_per_pack: "0.32",
        change_rm_per_pack: "0.04",
        evidence_id: "receipt-packpro"
      }
    ]
  },
  evidence: [
    {
      evidence_id: "receipt-sinar",
      title: "Sinar Borong Jaya receipt",
      asset_uri: "/evidence/receipt_001_sinar_borong.jpg",
      receipt_id: "SBR-120726-184",
      supplier_name: "Sinar Borong Jaya",
      transcript: null,
      line_items: [
        {
          raw_name: "Telur Gred B 30 biji x 3 tray",
          component_id: "c_egg",
          total_price_rm: "49.50",
          confidence: "0.98"
        }
      ]
    },
    {
      evidence_id: "receipt-packpro",
      title: "PackPro Trading receipt",
      asset_uri: "/evidence/receipt_002_packpro.jpg",
      receipt_id: "PPT-260712-077",
      supplier_name: "PackPro Trading",
      transcript: null,
      line_items: [
        {
          raw_name: "Bekas Makanan 50 pcs x 4",
          component_id: "c_packaging",
          total_price_rm: "40.00",
          confidence: "0.98"
        }
      ]
    }
  ],
  assumptions: [
    "Gross profit excludes rent, wages and other overheads.",
    "Costs use the latest merchant-confirmed receipt lines."
  ]
};

const receiptUpload = {
  state: "clarification_required",
  event_id: "receipt-upload-browser-003",
  evidence_uri: "synthetic://evidence/receipt-upload-browser-003",
  extraction: {
    receipt_id: "PPSS2-1207",
    supplier_name: "Pasar Pagi SS2",
    date: "2026-07-12",
    currency: "MYR",
    line_items: [
      {
        raw_name: "Ikan bilis 1kg",
        normalized_component_id: "c_anchovy",
        quantity: "1",
        uom: "kg",
        pack_size: null,
        unit_price_rm: "28.50",
        total_price_rm: "28.50",
        confidence: "0.72"
      }
    ],
    total_rm: "28.50",
    overall_confidence: "0.78",
    ambiguities: [
      {
        field: "line_items[0].quantity",
        question: "Confirm ikan bilis quantity and total?",
        options: ["1 kg, RM28.50", "Needs correction"]
      }
    ]
  },
  clarifications: [
    {
      field: "line_items[0].quantity",
      question: "Confirm ikan bilis quantity and total?",
      options: ["1 kg, RM28.50", "Needs correction"]
    }
  ]
};

const purchaseIntakeReview = {
  state: "ready_for_confirmation",
  intake_id: "purchase-intake-browser-001",
  version: 1,
  missing_fields: [],
  confirmation_token: "confirmation-browser-001",
  summary: {
    supplier_name: "Pasar Pagi",
    component_id: "c_egg",
    item_name: "Telur",
    quantity: "3",
    uom: "tray",
    pack_size: "30",
    total_price_rm: "49.50",
    occurred_at: "2026-07-12T04:00:00.000Z",
    payment_method: "cash",
    note: "Morning stock"
  }
};

function apiRequest(request) {
  if (
    request.method === "GET" &&
    request.url.pathname === "/api/v1/summary/daily"
  ) {
    return { body: dailySummary };
  }
  if (
    request.method === "GET" &&
    request.url.pathname === "/api/v1/catalog/components"
  ) {
    return {
      body: {
        merchant_id: "m_kak_lina_001",
        components: [
          { component_id: "c_anchovy", name: "Ikan Bilis" },
          { component_id: "c_egg", name: "Telur" }
        ]
      }
    };
  }
  if (
    request.method === "POST" &&
    request.url.pathname === "/api/v1/simulations/price"
  ) {
    return {
      body: {
        revenue_rm: "192.50",
        cogs_rm: "111.30",
        gross_profit_rm: "81.20",
        gross_margin_pct: "42.18",
        incremental_gross_profit_vs_today_rm: "8.40",
        assumption: "constant_demand"
      }
    };
  }
  if (
    request.method === "POST" &&
    request.url.pathname === "/api/v1/receipts/extract"
  ) {
    return { body: receiptUpload };
  }
  if (
    request.method === "POST" &&
    request.url.pathname === "/api/v1/receipts/confirm"
  ) {
    return {
      body: {
        state: "committed",
        event_id: "cost-receipt-browser-003"
      }
    };
  }
  if (
    request.method === "POST" &&
    request.url.pathname === "/api/v1/purchase-intakes"
  ) {
    return { body: purchaseIntakeReview };
  }
  if (
    request.method === "POST" &&
    request.url.pathname === "/api/v1/purchase-intakes/confirm"
  ) {
    return {
      body: {
        state: "committed",
        event_id: "cost-cash-browser-001"
      }
    };
  }
  return {
    status: 404,
    body: { error: `Unexpected browser regression API path ${request.url}` }
  };
}

async function dashboard() {
  await navigate(connection, `${server.baseUrl}/?lang=en`);
  await waitForExpression(
    connection,
    "dashboard hydration",
    `document.body.innerText.includes("36.40%") &&
      Boolean(
        document.querySelector('button[aria-label="View evidence for Telur"]')
      )`
  );
}

async function receipts() {
  await navigate(connection, `${server.baseUrl}/receipts?lang=en`);
  await waitForExpression(
    connection,
    "receipt review hydration",
    `(() => {
      const input = document.querySelector(
        'input[aria-label="Upload receipt photo"]'
      );
      return Boolean(
        input
        && Object.keys(input).some((key) => key.startsWith("__reactProps$"))
      );
    })()`
  );
}

async function clickBySelector(selector) {
  const clicked = await evaluate(
    connection,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "nearest" });
      element.click();
      return true;
    })()`
  );
  assert.equal(clicked, true, `Expected browser element ${selector}`);
}

async function clickByText(text) {
  const clicked = await evaluate(
    connection,
    `(() => {
      const element = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent.trim() === ${JSON.stringify(text)}
      );
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "nearest" });
      element.click();
      return true;
    })()`
  );
  assert.equal(clicked, true, `Expected browser button "${text}"`);
}

async function setInput(label, value) {
  const changed = await evaluate(
    connection,
    `(() => {
      const input = document.querySelector(
        'input[aria-label=${JSON.stringify(label)}]'
      ) ?? [...document.querySelectorAll("label")].find(
        (candidate) =>
          candidate.querySelector(":scope > span")?.textContent.trim()
            === ${JSON.stringify(label)}
      )?.querySelector("input");
      if (!input) return false;
      input.scrollIntoView({ block: "center", inline: "nearest" });
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value;
    })()`
  );
  assert.equal(changed, value, `Expected ${label} to accept ${value}`);
}

async function setSelect(label, value) {
  const changed = await evaluate(
    connection,
    `(() => {
      const select = [...document.querySelectorAll("label")].find(
        (candidate) =>
          candidate.querySelector(":scope > span")?.textContent.trim()
            === ${JSON.stringify(label)}
      )?.querySelector("select");
      if (!select) return false;
      select.scrollIntoView({ block: "center", inline: "nearest" });
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      ).set;
      setter.call(select, ${JSON.stringify(value)});
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value;
    })()`
  );
  assert.equal(changed, value, `Expected ${label} to select ${value}`);
}

async function assertNoHorizontalOverflow(context) {
  const geometry = await evaluate(
    connection,
    `({
      innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth
    })`
  );
  assert.equal(geometry.innerWidth, viewport.width);
  assert.ok(
    geometry.bodyScrollWidth <= viewport.width,
    `${context} body overflows: ${JSON.stringify(geometry)}`
  );
  assert.ok(
    geometry.documentScrollWidth <= viewport.width,
    `${context} document overflows: ${JSON.stringify(geometry)}`
  );
}

async function setViewport(width, height, mobile) {
  await connection.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height
  });
}

before(async () => {
  mockApi = await startMockApi(apiRequest);
  server = await startWebServer({ apiBaseUrl: mockApi.baseUrl });
  browser = await startBrowser(viewport);
  connection = browser.connection;
  await navigate(connection, `${server.baseUrl}/login`);
  const loginStatus = await evaluate(
    connection,
    `fetch("/api/pasarai/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        access_code: "browser-regression-access",
        next: "/"
      })
    }).then((response) => response.status)`
  );
  assert.equal(loginStatus, 200);
  const sessionStatus = await evaluate(
    connection,
    `fetch("/api/pasarai/session", {
      credentials: "same-origin"
    }).then((response) => response.status)`
  );
  assert.equal(
    sessionStatus,
    200,
    "Production session cookie was not accepted on the localhost origin"
  );
});

after(async () => {
  const cleanup = await Promise.allSettled(
    [browser?.stop(), server?.stop(), mockApi?.stop()].filter(Boolean)
  );
  const failures = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) {
    throw new AggregateError(failures, "Browser regression cleanup failed");
  }
});

test("renders dashboard key values and cards at 390px without horizontal overflow", async () => {
  await dashboard();
  const state = await evaluate(
    connection,
    `(() => {
      const text = document.body.innerText;
      const headings = [...document.querySelectorAll(".ledger-module h2")]
        .map((heading) => heading.textContent.trim());
      const baselineValue = document.querySelector(
        ".cost-before strong"
      )?.getBoundingClientRect();
      const baselineDate = document.querySelector(
        ".cost-snapshot-date"
      );
      const baselineDateBounds = baselineDate?.getBoundingClientRect();
      const baselineColumn = document.querySelector(
        ".cost-before"
      )?.getBoundingClientRect();
      return {
        headings,
        hasMargin: /36\.40\s*%/u.test(text),
        hasProfit: /RM\s*72\.80/u.test(text),
        hasCost: /RM\s*3\.18/u.test(text),
        baselineDateLabel: baselineDate
          ?.querySelector("span")
          ?.textContent.trim(),
        baselineDate: baselineDate
          ?.querySelector("time")
          ?.textContent.trim(),
        baselineDateBelowValue: Boolean(
          baselineValue
          && baselineDateBounds
          && baselineColumn
          && baselineDateBounds.top >= baselineValue.bottom
          && baselineDateBounds.left >= baselineColumn.left
          && baselineDateBounds.right <= baselineColumn.right
        )
      };
    })()`
  );
  assert.deepEqual(state.headings, [
    "Today’s gross margin",
    "Cost per pack",
    "Price and volume simulation"
  ]);
  assert.equal(state.hasMargin, true);
  assert.equal(state.hasProfit, true);
  assert.equal(state.hasCost, true);
  assert.equal(state.baselineDateLabel, "Baseline date");
  assert.equal(state.baselineDate, "11 Jul 2026");
  assert.equal(state.baselineDateBelowValue, true);
  await assertNoHorizontalOverflow("dashboard");
});

test("previews client-only products from the compact dashboard picker", async () => {
  await dashboard();
  await clickBySelector('button[aria-label="Choose product"]');

  const picker = await waitForExpression(
    connection,
    "dashboard product picker",
    `(() => {
      const dialog = document.querySelector(
        '[role="dialog"][aria-labelledby="product-picker-title"]'
      );
      if (!dialog) return null;
      const bounds = dialog.getBoundingClientRect();
      return {
        title: dialog.querySelector("h2")?.textContent.trim(),
        productCount: dialog.querySelectorAll(
          "button[data-product-id]"
        ).length,
        connectedSelected: dialog.querySelector(
          'button[data-product-id="p_nlb_001"]'
        )?.getAttribute("aria-pressed"),
        addRecipePresent: [...dialog.querySelectorAll("button")].some(
          (button) => button.textContent.trim() === "Add recipe"
        ),
        demoTagCount: dialog.querySelectorAll(
          ".product-mode--demo, .demo-preview-chip"
        ).length,
        triggerBeforeTitle: document.querySelector(
          ".page-intro-title"
        )?.firstElementChild?.matches(".product-menu-trigger"),
        insideViewport:
          bounds.left >= 0
          && bounds.right <= innerWidth
          && bounds.top >= 0
          && bounds.bottom <= innerHeight
      };
    })()`
  );
  assert.deepEqual(picker, {
    title: "Products sold here",
    productCount: 4,
    connectedSelected: "true",
    addRecipePresent: true,
    demoTagCount: 0,
    triggerBeforeTitle: true,
    insideViewport: true
  });
  await assertNoHorizontalOverflow("product picker");

  await clickBySelector(
    'button[data-product-id="demo_nasi_lemak_ayam"]'
  );
  const preview = await waitForExpression(
    connection,
    "demo product preview",
    `(() => {
      const title = document.querySelector(".page-intro h1")
        ?.textContent.trim();
      if (title !== "Nasi Lemak Ayam Goreng") return null;
      return {
        title,
        margin: document.querySelector(".metric-value")
          ?.textContent.trim(),
        grossProfit: document.querySelector(
          ".finance-ledger__focus dd"
        )?.textContent.trim(),
        currentCost: document.querySelector(".cost-total strong")
          ?.textContent.trim(),
        demoTagPresent: Boolean(
          document.querySelector(".demo-preview-chip")
        ),
        addPurchasePresent: Boolean(
          document.querySelector(".add-purchase-link")
        ),
        simulationDisabled: document.querySelector(
          ".simulation-button"
        )?.disabled
      };
    })()`
  );
  assert.deepEqual(preview, {
    title: "Nasi Lemak Ayam Goreng",
    margin: "35.00%",
    grossProfit: "RM100.80",
    currentCost: "RM4.50",
    demoTagPresent: false,
    addPurchasePresent: false,
    simulationDisabled: true
  });
  await assertNoHorizontalOverflow("demo product preview");

  await clickBySelector('button[aria-label="Choose product"]');
  await clickByText("Add recipe");
  await setInput("Recipe name", "Nasi Lemak Ikan Keli");
  await clickByText("Add recipe");

  const newRecipe = await waitForExpression(
    connection,
    "session recipe preview",
    `(() => {
      const title = document.querySelector(".page-intro h1")
        ?.textContent.trim();
      if (title !== "Nasi Lemak Ikan Keli") return null;
      return {
        title,
        grossProfit: document.querySelector(
          ".finance-ledger__focus dd"
        )?.textContent.trim(),
        currentCost: document.querySelector(".cost-total strong")
          ?.textContent.trim(),
        addPurchasePresent: Boolean(
          document.querySelector(".add-purchase-link")
        ),
        simulationDisabled: document.querySelector(
          ".simulation-button"
        )?.disabled
      };
    })()`
  );
  assert.deepEqual(newRecipe, {
    title: "Nasi Lemak Ikan Keli",
    grossProfit: "RM75.60",
    currentCost: "RM3.90",
    addPurchasePresent: false,
    simulationDisabled: true
  });
  await assertNoHorizontalOverflow("session recipe preview");

  await clickBySelector('button[aria-label="Choose product"]');
  const sessionRecipeList = await waitForExpression(
    connection,
    "session recipe in product picker",
    `(() => {
      const dialog = document.querySelector(".product-picker-dialog");
      const selected = dialog?.querySelector(
        'button[data-product-id="session_recipe_1"]'
      );
      return dialog && selected
        ? {
            productCount: dialog.querySelectorAll(
              "button[data-product-id]"
            ).length,
            selected: selected.getAttribute("aria-pressed"),
            name: selected.textContent.trim()
          }
        : null;
    })()`
  );
  assert.deepEqual(sessionRecipeList, {
    productCount: 5,
    selected: "true",
    name: "Nasi Lemak Ikan KeliSelected"
  });
  await clickBySelector(".product-picker-close");
});

test("keeps the gross-margin figure clear of the baseline panel on desktop", async () => {
  await setViewport(1440, 900, false);
  try {
    await dashboard();
    const geometry = await evaluate(
      connection,
      `(() => {
        const metric = document.querySelector(".metric-value")?.getBoundingClientRect();
        const baseline = document.querySelector(".baseline-track")?.getBoundingClientRect();
        return metric && baseline && {
          metricRight: metric.right,
          baselineLeft: baseline.left,
          metricBottom: metric.bottom,
          baselineBottom: baseline.bottom
        };
      })()`
    );
    assert.ok(geometry, "Expected margin metric and baseline panel geometry");
    assert.ok(
      geometry.metricRight <= geometry.baselineLeft,
      `Gross-margin figure overlaps baseline panel: ${JSON.stringify(geometry)}`
    );
  } finally {
    await setViewport(viewport.width, viewport.height, true);
  }
});

test("keeps simulation controls usable and renders the browser API result", async () => {
  await dashboard();
  await setInput("Proposed price", "5.50");
  await setInput("Expected quantity", "35");
  await clickByText("Run simulation");
  const result = await waitForExpression(
    connection,
    "simulation result",
    `document.querySelector(".simulation-result-primary")?.innerText`
  );
  assert.match(result, /RM81\.20/u);
  assert.match(result, /\+RM8\.40/u);
  await assertNoHorizontalOverflow("simulation result");
});

test("opens the correct evidence drawer and closes it at 390px", async () => {
  await dashboard();
  await clickBySelector('button[aria-label="View evidence for Telur"]');
  const drawer = await waitForExpression(
    connection,
    "Sinar Borong Jaya evidence drawer",
    `(() => {
      const dialog = document.querySelector(
        '[role="dialog"][aria-label="Sinar Borong Jaya receipt"]'
      );
      return dialog && {
        receipt: dialog.textContent.includes("SBR-120726-184"),
        line: dialog.textContent.includes("Telur Gred B 30 biji x 3 tray"),
        image: dialog.querySelector("img")?.getAttribute("src"),
        receiptLink: dialog.querySelector(
          'a[aria-label="Open receipt SBR-120726-184"]'
        )?.getAttribute("href")
      };
    })()`
  );
  assert.deepEqual(drawer, {
    receipt: true,
    line: true,
    image: "/evidence/receipt_001_sinar_borong.jpg",
    receiptLink: "/evidence/receipt_001_sinar_borong.jpg"
  });
  await assertNoHorizontalOverflow("evidence drawer");
  await clickBySelector('button[aria-label="Close evidence"]');
  await waitForExpression(
    connection,
    "closed evidence drawer",
    `!document.querySelector('[role="dialog"]')`
  );
});

test("keeps the evidence drawer compact on desktop", async () => {
  await setViewport(1440, 900, false);
  try {
    await dashboard();
    await clickBySelector('button[aria-label="View evidence for Telur"]');
    const geometry = await waitForExpression(
      connection,
      "compact desktop evidence drawer",
      `(() => {
        const drawer = document.querySelector(".evidence-drawer");
        if (!drawer) return null;
        const bounds = drawer.getBoundingClientRect();
        if (Math.abs(bounds.right - innerWidth) > 0.5) return null;
        return {
          width: bounds.width,
          right: bounds.right,
          viewportWidth: innerWidth
        };
      })()`
    );
    assert.ok(
      geometry.width <= 480.5,
      `Evidence drawer is too wide: ${JSON.stringify(geometry)}`
    );
    assert.ok(
      Math.abs(geometry.right - geometry.viewportWidth) <= 0.5,
      `Evidence drawer is not flush with the viewport: ${JSON.stringify(geometry)}`
    );
  } finally {
    await setViewport(viewport.width, viewport.height, true);
  }
});

test("does not render the live advisor agent", async () => {
  await dashboard();
  const advisorPresent = await evaluate(
    connection,
    `Boolean(
      document.querySelector(
        '[aria-label="Live Advisor"], elevenlabs-convai'
      )
    )`
  );
  assert.equal(advisorPresent, false);
});

test("supports receipt review edits and reaches the confirmed state at 390px", async () => {
  await receipts();
  const uploaded = await evaluate(
    connection,
    `(() => {
      const input = document.querySelector(
        'input[aria-label="Upload receipt photo"]'
      );
      if (!input) return false;
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(
          [new Uint8Array([255, 216, 255, 217])],
          "receipt_003_pasar_pagi.jpg",
          { type: "image/jpeg" }
        )
      );
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`
  );
  assert.equal(uploaded, true);
  const extractionState = await waitForExpression(
    connection,
    "receipt extraction",
    `(() => {
      const panel = document.querySelector("#purchase-panel-receipt");
      const supplier = panel?.querySelector(
        'input[aria-label="Supplier"]'
      )?.value;
      const error = [...(panel?.querySelectorAll(".inline-error") ?? [])]
        .map((candidate) => candidate.textContent.trim())
        .find(Boolean);
      return supplier === "Pasar Pagi SS2" || error
        ? { supplier, error: error ?? null }
        : null;
    })()`
  );
  assert.equal(
    extractionState.supplier,
    "Pasar Pagi SS2",
    extractionState.error ?? "Receipt extraction did not populate the supplier"
  );
  const initial = await evaluate(
    connection,
    `(() => {
      const panel = document.querySelector("#purchase-panel-receipt");
      const confirmButton = [...document.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent.trim() === "Confirm and record costs"
      );
      return {
        supplier: panel?.querySelector('input[aria-label="Supplier"]')?.value,
        quantity: panel?.querySelector(
          'input[aria-label="Line 1 quantity"]'
        )?.value,
        hasQuestion: document.body.innerText.includes(
          "Confirm ikan bilis quantity and total?"
        ),
        questionContained: (() => {
          const box = document.querySelector(".clarification-box");
          const heading = box?.querySelector("h3");
          if (!box || !heading) return false;
          const boxRect = box.getBoundingClientRect();
          const headingRect = heading.getBoundingClientRect();
          return headingRect.left >= boxRect.left
            && headingRect.right <= boxRect.right;
        })(),
        confirmDisabled: confirmButton?.disabled
      };
    })()`
  );
  assert.deepEqual(initial, {
    supplier: "Pasar Pagi SS2",
    quantity: "1",
    hasQuestion: true,
    questionContained: true,
    confirmDisabled: true
  });

  await setInput("Line 1 pack size", "1");
  await clickByText("1 kg, RM28.50");
  const ready = await waitForExpression(
    connection,
    "receipt ready to confirm",
    `(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent.trim() === "Confirm and record costs"
      );
      return button && !button.disabled && button.textContent.trim();
    })()`
  );
  assert.equal(ready, "Confirm and record costs");
  await clickByText("Confirm and record costs");
  const confirmed = await waitForExpression(
    connection,
    "receipt confirmation state",
    `[...document.querySelectorAll("button")].some(
      (candidate) => candidate.textContent.trim() === "Verified costs recorded"
    )`
  );
  assert.equal(confirmed, true);

  await receipts();
  const restored = await waitForExpression(
    connection,
    "saved receipt reload",
    `document.querySelector('input[aria-label="Supplier"]')?.value ===
      "Pasar Pagi SS2"`
  );
  assert.equal(restored, true);
  const persistedImage = await evaluate(
    connection,
    `document.querySelector(
      'img[alt="Pasar Pagi SS2 receipt source evidence"]'
    )?.getAttribute("src")`
  );
  assert.match(persistedImage, /^data:image\/jpeg;base64,/u);

  await clickBySelector(
    'button[aria-label="Delete Pasar Pagi SS2 receipt"]'
  );
  const deleted = await waitForExpression(
    connection,
    "saved receipt deletion",
    `!document.body.innerText.includes("Pasar Pagi SS2") &&
      localStorage.length === 0`
  );
  assert.equal(deleted, true);
  await assertNoHorizontalOverflow("receipt confirmation");
});

test("records a cash purchase through review and confirmation at 390px", async () => {
  await navigate(
    connection,
    `${server.baseUrl}/receipts?lang=en&date=2026-07-12&entry=cash`
  );
  await waitForExpression(
    connection,
    "cash purchase hydration",
    `(() => {
      const select = [...document.querySelectorAll("label")].find(
        (candidate) =>
          candidate.querySelector(":scope > span")?.textContent.trim()
            === "Component"
      )?.querySelector("select");
      return Boolean(
        document.body.innerText.includes("Record a cash purchase")
        && select
        && Object.keys(select).some((key) => key.startsWith("__reactProps$"))
      );
    })()`
  );

  await setSelect("Component", "c_egg");
  await setInput("Supplier", "Pasar Pagi");
  await setInput("Quantity bought", "3");
  await setInput("Purchase unit", "tray");
  await setInput("One unit contains", "30");
  await setInput("Total paid", "49.5");
  const noteChanged = await evaluate(
    connection,
    `(() => {
      const input = document.querySelector('textarea[aria-label="Note"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(input, "Morning stock");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value;
    })()`
  );
  assert.equal(noteChanged, "Morning stock");

  await clickByText("Review purchase");
  const review = await waitForExpression(
    connection,
    "cash purchase review",
    `(() => {
      const heading = [...document.querySelectorAll("h1")].find(
        (candidate) => candidate.textContent.trim() === "Review cash purchase"
      );
      return heading
        ? {
            total: document.body.innerText.includes("RM49.50"),
            confirm: [...document.querySelectorAll("button")].some(
              (candidate) =>
                candidate.textContent.trim() === "Confirm purchase"
            )
          }
        : null;
    })()`
  );
  assert.deepEqual(review, { total: true, confirm: true });
  await assertNoHorizontalOverflow("cash purchase review");

  await clickByText("Confirm purchase");
  const success = await waitForExpression(
    connection,
    "cash purchase confirmation",
    `(() => {
      const heading = [...document.querySelectorAll("h1")].find(
        (candidate) => candidate.textContent.trim() === "Purchase recorded"
      );
      const link = [...document.querySelectorAll("a")].find(
        (candidate) =>
          candidate.textContent.trim() === "View dashboard for this date"
      );
      return heading && link
        ? { href: new URL(link.href).pathname + new URL(link.href).search }
        : null;
    })()`
  );
  assert.deepEqual(success, { href: "/?lang=en&date=2026-07-12" });
});
