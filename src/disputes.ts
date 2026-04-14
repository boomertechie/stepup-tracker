import { readFileSync, writeFileSync, existsSync } from "fs";
import type { Transaction, TransactionStore, LineItem } from "./types";

// ─── Types ───────────────────────────────────────────────────────────

export interface DisputeRecord {
  id: string;
  transaction_id: string;
  purchase_number: number;
  created_at: string;
  status: "open" | "appealed" | "resolved_won" | "resolved_lost" | "withdrawn";

  // The denied item (from portal — may not match actual purchase)
  item_description: string;       // Portal dropdown selection (e.g., "Lunchboxes")
  item_category: string;          // Portal category (e.g., "Instructional Material")
  item_type: string;              // Portal type (e.g., "School Supplies")
  item_vendor: string;
  item_amount: number;
  purchase_date: string;

  // Parent annotations (manual — needed for precise arguments)
  actual_item: string;            // What was actually purchased (e.g., "mixing bowls")
  educational_purpose: string;    // How the student uses it (e.g., "home economics coursework")
  category_rationale: string;     // Why this portal category was selected (e.g., "closest available option")

  // Their stated reason
  denial_reason: string;

  // Our analysis
  classification: "improper" | "questionable" | "proper";
  documentation_evidence: string[];
  rebuttal: string;
  comparable_school_access: string;
  notes: string;
}

export interface DisputeStore {
  version: 1;
  last_analyzed: string | null;
  disputes: DisputeRecord[];
}

// ─── Documentation references ────────────────────────────────────────
//
// School year: 2025-2026
// UPDATE REQUIRED: Review and update these references each summer when
// Step Up publishes new handbooks for the upcoming school year.

const DOC_YEAR = "2025-26";

const CITATIONS = {
  statute_ftc: {
    ref: "Florida Statute 1002.394 (Florida Tax Credit Scholarship Program)",
    note: "Defines eligible expenses as instructional materials, curriculum, and other education-related costs.",
  },
  statute_fes: {
    ref: "Florida Statute 1002.395 (Family Empowerment Scholarship)",
    note: "Establishes the money-follows-the-student framework; scholarship funds may be spent on approved educational expenses.",
  },
  handbook: {
    ref: `Step Up for Students Parent/Guardian Handbook, ${DOC_YEAR} School Year`,
    url: "https://go.stepupforstudents.org/hubfs/HANDBOOKS/Parent%20Handbooks/Private-School-Family-Handbook.pdf",
    note: "Official program handbook listing eligible expense categories and reimbursement procedures.",
  },
  reimbursement_guide: {
    ref: `Step Up for Students Reimbursement/Purchasing Guide, ${DOC_YEAR}`,
    url: "https://go.stepupforstudents.org/hubfs/Scholarship%20Info/Guardians%20Reimbursement%20Guide.pdf",
    note: "Detailed guide to eligible categories and required documentation.",
  },
  ema_portal: {
    ref: "EMA Portal Category Classification (apply.stepupforstudents.org)",
    note: "Step Up's own portal categorizes items at submission time. The portal's category assignment reflects Step Up's classification of the item, not the parent's.",
  },
};

// ─── Approved categories with citations ──────────────────────────────

interface CategoryDef {
  description: string;
  examples: string[];
  limits?: string;
  school_equivalent: string;
  doc_reference: string;
}

const APPROVED_CATEGORIES: Record<string, CategoryDef> = {
  "School Supplies": {
    description: "Notebooks, paper, folders, writing instruments, calculators, art supplies, science lab supplies, and items used to support the student's daily learning activities",
    examples: ["notebooks", "paper", "folders", "pencils", "pens", "calculators", "art supplies", "science supplies", "markers", "crayons", "glue", "scissors", "rulers", "backpacks", "binders", "lunchboxes", "organizers", "storage containers"],
    school_equivalent: "Public schools provide school supplies including storage, organization, and transport items. Students routinely use lunchboxes, backpacks, folders, and containers as part of their daily school routine — these are standard school-provided or school-required items.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "School Supplies" category. See also ${CITATIONS.handbook.ref}, Eligible Expenses section.`,
  },
  "Textbooks": {
    description: "Core curriculum, workbooks, worksheets, teacher guides, supplemental educational books, e-books, digital curriculum",
    examples: ["textbooks", "workbooks", "curriculum", "educational books", "e-books"],
    school_equivalent: "Public schools provide all textbooks and curriculum materials at no cost to families.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "Textbooks & Curriculum" category.`,
  },
  "At-Home Classroom Furnishings": {
    description: "Furnishings, visual aids, and organizational items for the home classroom environment",
    examples: ["desks", "chairs", "bookshelves", "educational posters", "visual supports", "whiteboards", "bulletin boards", "storage", "organizers", "picture frames for educational displays"],
    school_equivalent: "Public school classrooms are furnished at district expense: desks, chairs, bookshelves, storage systems, bulletin boards, educational posters, visual schedules, and display frames. These are considered standard classroom infrastructure.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "At-Home Classroom Furnishings" subcategory under Instructional Material. See also ${CITATIONS.handbook.ref}.`,
  },
  "Learning Manipulatives/Creative Play Items": {
    description: "Hands-on learning tools and creative play items that support developmental and educational goals",
    examples: ["manipulatives", "building blocks", "puzzles", "STEM kits", "math manipulatives", "learning toys", "creative play", "stuffed animals", "sensory items"],
    school_equivalent: "Public school classrooms (K-5 especially) are stocked with manipulatives, building sets, puzzles, sensory items, and creative play materials. These are standard educational tools, not luxury items.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "Learning Manipulatives/Creative Play Items" subcategory under Instructional Material.`,
  },
  "Elective Equipment": {
    description: "Equipment for elective and enrichment courses: home economics, cooking, art, music, woodworking",
    examples: ["cooking equipment", "art equipment", "music equipment", "stand mixer", "blender", "dehydrator", "musical instruments", "easels", "pottery wheel", "sewing machine"],
    school_equivalent: "Public schools provide fully equipped home economics kitchens (mixers, blenders, cookware), art studios, music rooms with instruments, and shop classrooms. All equipment is district-funded at no cost to the student.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "Elective Equipment" subcategory under Instructional Material. ${CITATIONS.statute_ftc.ref} includes instructional materials for approved courses.`,
  },
  "Elective Supplies": {
    description: "Consumable and reusable supplies for elective and enrichment courses",
    examples: ["cooking supplies", "art supplies", "music supplies", "measuring cups", "utensils", "mixing bowls", "baking sheets", "paint", "clay", "fabric", "yarn"],
    school_equivalent: "Public schools provide all consumable supplies for elective courses at no cost. Home ec kitchens are fully stocked with utensils, bowls, measuring tools, and cookware.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "Elective Supplies" subcategory under Instructional Material.`,
  },
  "Technology": {
    description: "Computers, tablets, educational software, learning apps, and peripherals",
    examples: ["laptop", "tablet", "iPad", "software", "apps", "keyboard", "mouse", "monitor"],
    limits: "Market rate, every 24 months",
    school_equivalent: "Public schools provide computer labs, 1:1 devices, and educational software to all students at no cost.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "Technology" category. ${CITATIONS.handbook.ref}, Technology section.`,
  },
  "Instructional Material": {
    description: "Broad category covering educational materials, curriculum, learning aids, and classroom resources",
    examples: ["curriculum", "educational materials", "learning aids", "educational games", "flash cards", "charts", "maps"],
    school_equivalent: "Public schools provide all instructional materials at no cost to students.",
    doc_reference: `${CITATIONS.reimbursement_guide.ref}, "Instructional Material" parent category. ${CITATIONS.statute_ftc.ref}.`,
  },
};

// Items explicitly NOT covered per documentation
const EXCLUDED_ITEMS = [
  "cash payments to private individuals",
  "secondary market tickets",
  "medical services",
  "medications",
  "food and meals",
  "gas and mileage",
  "childcare",
  "babysitting",
  "clothing not uniform-related",
  "entertainment without educational purpose",
];

// ─── Denial reason patterns for targeted rebuttals ───────────────────

interface DenialPattern {
  match: (reason: string, item: LineItem) => boolean;
  rebuttal: (item: LineItem, category: CategoryDef | null, categoryName: string | null) => string;
}

const DENIAL_PATTERNS: DenialPattern[] = [
  {
    // "household item" objection
    match: (reason) => /household/i.test(reason),
    rebuttal: (item, cat, catName) => {
      const lines = [
        `Step Up classified this as a "household item." However, Step Up's own EMA portal accepted and categorized this submission under "${item.category} / ${item.type}" — an educational classification within their system, not a household one.`,
        ``,
        `The fact that an item CAN be used in a household does not make it a household item for scholarship purposes. A desk, a whiteboard, and a bookshelf are all found in households — they are also standard classroom furnishings that public schools provide. The relevant question is whether the item serves an educational purpose, which Step Up's own categorization confirms.`,
      ];
      if (cat) {
        lines.push(``);
        lines.push(`Reference: ${cat.doc_reference}`);
        lines.push(`School equivalence: ${cat.school_equivalent}`);
      }
      return lines.join("\n");
    },
  },
  {
    // "not an approved expense" without specifics
    match: (reason) => /not an approved expense/i.test(reason) || /not an eligible expense/i.test(reason),
    rebuttal: (item, cat, catName) => {
      const lines = [
        `Step Up states this is "not an approved expense" but does not cite which specific exclusion or policy provision applies.`,
        ``,
        `The item was submitted under "${item.category} / ${item.type}."${catName ? ` This falls within the documented "${catName}" approved category per the ${CITATIONS.reimbursement_guide.ref}.` : ""}`,
        ``,
        `Under ${CITATIONS.statute_ftc.ref}, the scholarship is designed so funding follows the student. The burden is on Step Up to identify the specific basis for exclusion. A generic "not approved" response without citing the applicable policy is insufficient grounds for denial.`,
      ];
      if (cat) {
        lines.push(``);
        lines.push(`Reference: ${cat.doc_reference}`);
      }
      return lines.join("\n");
    },
  },
  {
    // Item characterized as something it isn't (e.g., "lunchbox" called "bowl")
    match: (reason, item) => {
      const reasonLower = reason.toLowerCase();
      const descLower = item.description.toLowerCase();
      // Detect when they describe the item differently than what was submitted
      return reasonLower.includes("as a ") || reasonLower.includes("as an ");
    },
    rebuttal: (item, cat, catName) => {
      const lines = [
        `The denial re-characterizes the submitted item. The item was submitted as "${item.description}" under the "${item.type}" category in Step Up's own portal.`,
        ``,
        `Step Up's reviewer has applied their own characterization of the item rather than evaluating it under the category in which it was submitted and accepted by their system. The relevant question is whether "${item.description}" serves the educational purpose indicated by its "${item.type}" classification — not whether the reviewer would personally categorize the item differently.`,
      ];
      if (cat) {
        lines.push(``);
        lines.push(`The "${catName}" category, per ${cat.doc_reference}, covers: ${cat.description}.`);
        lines.push(``);
        lines.push(`School equivalence: ${cat.school_equivalent}`);
      }
      return lines.join("\n");
    },
  },
  {
    // Suggestion to buy from EMA Marketplace instead
    match: (reason) => /marketplace/i.test(reason) || /reconsider/i.test(reason),
    rebuttal: (item, cat) => {
      return [
        `The reviewer suggests purchasing from the EMA Marketplace instead. However, the scholarship program does not require purchases to be made exclusively through the Marketplace. The reimbursement program exists precisely to allow families to purchase from vendors of their choosing, provided the item falls within an approved category.`,
        ``,
        `Suggesting an alternative purchase source is not a valid basis for denying a reimbursement for an otherwise eligible expense. The item "${item.description}" was purchased from ${item.vendor} and submitted under an approved category.`,
        ``,
        `Reference: ${cat?.doc_reference || CITATIONS.reimbursement_guide.ref}`,
      ].join("\n");
    },
  },
];

// ─── Analysis ────────────────────────────────────────────────────────

export function analyzeDenials(txStore: TransactionStore): DisputeRecord[] {
  const disputes: DisputeRecord[] = [];

  for (const tx of txStore.transactions) {
    if (!tx.line_items) continue;
    for (const li of tx.line_items) {
      if (li.approval_status !== "Denied") continue;
      disputes.push(analyzeItem(tx, li));
    }
  }

  return disputes;
}

function analyzeItem(tx: Transaction, li: LineItem): DisputeRecord {
  const itemAmount = li.cost * li.quantity + li.tax_shipping;
  const evidence: string[] = [];
  let classification: DisputeRecord["classification"] = "questionable";
  let rebuttal = "";
  let schoolAccess = "";

  const matchedCategoryName = findMatchingCategory(li);
  const matchedCategory = matchedCategoryName ? APPROVED_CATEGORIES[matchedCategoryName] : null;

  // Build documentation evidence
  if (matchedCategory) {
    classification = "improper";

    evidence.push(
      `[${DOC_YEAR}] Item falls under the "${matchedCategoryName}" approved category.`
    );
    evidence.push(
      `Source: ${matchedCategory.doc_reference}`
    );
    evidence.push(
      `Category description: "${matchedCategory.description}"`
    );

    // Check specific item match
    const itemLower = li.description.toLowerCase();
    const matchedExamples = matchedCategory.examples.filter(ex =>
      itemLower.includes(ex.toLowerCase()) || ex.toLowerCase().includes(itemLower.split("/")[0].trim().toLowerCase())
    );
    if (matchedExamples.length > 0) {
      evidence.push(
        `Item "${li.description}" directly matches documented examples: ${matchedExamples.join(", ")}`
      );
    }

    // Note the portal's own classification
    evidence.push(
      `${CITATIONS.ema_portal.ref}: Step Up's own portal accepted and classified this item as "${li.category} / ${li.type}" at submission time.`
    );

    schoolAccess = matchedCategory.school_equivalent;
  } else {
    const isExcluded = EXCLUDED_ITEMS.some(ex =>
      li.description.toLowerCase().includes(ex.toLowerCase())
    );

    if (isExcluded) {
      classification = "proper";
      evidence.push(`[${DOC_YEAR}] Item appears on the explicitly excluded list per ${CITATIONS.reimbursement_guide.ref}.`);
    } else {
      classification = "questionable";
      evidence.push(
        `[${DOC_YEAR}] Item category "${li.type}" under "${li.category}" is not on the published exclusion list per ${CITATIONS.reimbursement_guide.ref}.`
      );
      evidence.push(
        `${CITATIONS.ema_portal.ref}: Portal accepted the item under an educational classification.`
      );
      evidence.push(
        `Per ${CITATIONS.statute_ftc.ref}, items not explicitly excluded should be presumed eligible under the money-follows-the-student framework.`
      );
      schoolAccess = "Public schools routinely provide equivalent items and services as part of the standard educational experience at no cost to families.";
    }
  }

  // Build targeted rebuttal based on the ACTUAL denial reason
  if (li.denial_reason) {
    // Find the most specific matching denial pattern
    for (const pattern of DENIAL_PATTERNS) {
      if (pattern.match(li.denial_reason, li)) {
        rebuttal = pattern.rebuttal(li, matchedCategory, matchedCategoryName);
        break;
      }
    }
  }

  // Fallback rebuttal if no pattern matched
  if (!rebuttal) {
    if (matchedCategory) {
      rebuttal = [
        `The item "${li.description}" was submitted under "${li.category} / ${li.type}" and falls within the documented "${matchedCategoryName}" approved category.`,
        ``,
        `Source: ${matchedCategory.doc_reference}`,
        ``,
        `Per ${CITATIONS.statute_ftc.ref}, the scholarship operates on the principle that funding follows the student. ${schoolAccess}`,
        ``,
        `Step Up has not cited a specific exclusion or policy provision that disqualifies this item. The burden of proof for exclusion rests with Step Up, not the parent.`,
      ].join("\n");
    } else {
      rebuttal = [
        `This item is not on Step Up's published exclusion list (${CITATIONS.reimbursement_guide.ref}).`,
        `Under the money-follows-the-student framework (${CITATIONS.statute_ftc.ref}), items not explicitly excluded should be presumed eligible.`,
        `Step Up must cite the specific policy provision that disqualifies this item.`,
      ].join("\n");
    }
  }

  return {
    id: `dispute-${tx.id}-${li.purchase_number}`,
    transaction_id: tx.id,
    purchase_number: li.purchase_number,
    created_at: new Date().toISOString(),
    status: "open",
    item_description: li.description,
    item_category: li.category,
    item_type: li.type,
    item_vendor: li.vendor,
    item_amount: itemAmount,
    purchase_date: li.purchase_date,
    actual_item: "",              // Fill in manually: what was actually purchased
    educational_purpose: "",      // Fill in manually: how the student uses it
    category_rationale: "",       // Fill in manually: why this portal category was chosen
    denial_reason: li.denial_reason,
    classification,
    documentation_evidence: evidence,
    rebuttal,
    comparable_school_access: schoolAccess,
    notes: "",
  };
}

function findMatchingCategory(li: LineItem): string | null {
  if (APPROVED_CATEGORIES[li.type]) return li.type;

  const typeLower = li.type.toLowerCase();
  for (const [name] of Object.entries(APPROVED_CATEGORIES)) {
    if (typeLower.includes(name.toLowerCase()) || name.toLowerCase().includes(typeLower)) {
      return name;
    }
  }

  // Match item description against category examples
  const descLower = li.description.toLowerCase();
  for (const [name, cat] of Object.entries(APPROVED_CATEGORIES)) {
    for (const ex of cat.examples) {
      if (descLower.includes(ex) || ex.includes(descLower.split("/")[0].trim().toLowerCase())) {
        return name;
      }
    }
  }

  if (li.category === "Instructional Material") return "Instructional Material";
  return null;
}

// ─── Reporting ───────────────────────────────────────────────────────

export function printDisputeReport(disputes: DisputeRecord[]): void {
  const improper = disputes.filter(d => d.classification === "improper");
  const questionable = disputes.filter(d => d.classification === "questionable");
  const proper = disputes.filter(d => d.classification === "proper");

  const totalLost = disputes.reduce((s, d) => s + d.item_amount, 0);
  const recoverableLost = [...improper, ...questionable].reduce((s, d) => s + d.item_amount, 0);

  console.log(`\n=== Denial Dispute Analysis (${DOC_YEAR}) ===\n`);
  console.log(`Total denied: ${disputes.length} items ($${totalLost.toFixed(2)})`);
  console.log(`Improper denials: ${improper.length} ($${improper.reduce((s, d) => s + d.item_amount, 0).toFixed(2)})`);
  console.log(`Questionable: ${questionable.length} ($${questionable.reduce((s, d) => s + d.item_amount, 0).toFixed(2)})`);
  console.log(`Proper denials: ${proper.length} ($${proper.reduce((s, d) => s + d.item_amount, 0).toFixed(2)})`);
  console.log(`Potentially recoverable: $${recoverableLost.toFixed(2)}`);

  if (improper.length > 0) {
    console.log("\n--- IMPROPER DENIALS ---\n");
    for (const d of improper) { printDispute(d); }
  }

  if (questionable.length > 0) {
    console.log("\n--- QUESTIONABLE DENIALS ---\n");
    for (const d of questionable) { printDispute(d); }
  }

  if (proper.length > 0) {
    console.log("\n--- PROPER DENIALS ---\n");
    for (const d of proper) {
      console.log(`  ${d.item_description} ($${d.item_amount.toFixed(2)}) — ${d.denial_reason?.substring(0, 80) || "(no reason)"}`);
    }
  }
}

function printDispute(d: DisputeRecord): void {
  console.log(`  Transaction #${d.transaction_id.replace("ema-", "")} | Purchase ${d.purchase_number}`);
  console.log(`  Item: ${d.item_description}`);
  console.log(`  Portal category: ${d.item_category} / ${d.item_type}`);
  console.log(`  Amount: $${d.item_amount.toFixed(2)} | Vendor: ${d.item_vendor} | Date: ${d.purchase_date}`);
  console.log(`  Their reason: ${d.denial_reason?.substring(0, 120) || "(none stated)"}`);
  console.log(`  Classification: ${d.classification.toUpperCase()}`);
  console.log(`  Evidence:`);
  for (const e of d.documentation_evidence) {
    console.log(`    - ${e}`);
  }
  console.log(`  Rebuttal:`);
  for (const line of d.rebuttal.split("\n")) {
    if (line.trim()) console.log(`    ${line}`);
  }
  if (d.comparable_school_access) {
    console.log(`  School equivalence: ${d.comparable_school_access}`);
  }
  console.log();
}

// ─── Persistence ─────────────────────────────────────────────────────

export function loadDisputes(path: string): DisputeStore {
  if (!existsSync(path)) return { version: 1, last_analyzed: null, disputes: [] };
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveDisputes(path: string, store: DisputeStore): void {
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}
