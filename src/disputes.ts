import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Transaction, TransactionStore, LineItem } from "./types";

// ─── Types ───────────────────────────────────────────────────────────

export interface DisputeRecord {
  id: string;
  transaction_id: string;
  purchase_number: number;
  created_at: string;
  status: "open" | "appealed" | "resolved_won" | "resolved_lost" | "withdrawn";

  // The denied item
  item_description: string;
  item_category: string;
  item_type: string;
  item_vendor: string;
  item_amount: number;
  purchase_date: string;

  // Their stated reason
  denial_reason: string;

  // Our analysis
  classification: "improper" | "questionable" | "proper";
  documentation_evidence: string[];
  legal_argument: string;
  comparable_school_access: string;
  notes: string;
}

export interface DisputeStore {
  version: 1;
  last_analyzed: string | null;
  disputes: DisputeRecord[];
}

// ─── Approved categories from Step Up documentation ──────────────────
//
// Source: REIMBURSEMENT-GUIDE.md and OPERATIONS.md
// These represent what IS covered. The burden of proof is on Step Up
// to show an item is NOT covered, not on the parent to prove it IS.

const APPROVED_CATEGORIES: Record<string, {
  description: string;
  examples: string[];
  limits?: string;
  school_equivalent: string;
}> = {
  "School Supplies": {
    description: "Notebooks, paper, folders, writing instruments, calculators, art supplies, science lab supplies",
    examples: ["notebooks", "paper", "folders", "pencils", "pens", "calculators", "art supplies", "science supplies", "markers", "crayons", "glue", "scissors", "rulers", "backpacks", "binders"],
    school_equivalent: "All public schools provide school supplies. Storage, organization, and transport of school materials (lunchboxes, backpacks, organizers) are standard school provisions.",
  },
  "Textbooks": {
    description: "Core curriculum, workbooks, worksheets, teacher guides, supplemental educational books, e-books, digital curriculum",
    examples: ["textbooks", "workbooks", "curriculum", "educational books", "e-books"],
    school_equivalent: "Public schools provide all textbooks and curriculum materials at no cost to families.",
  },
  "At-Home Classroom Furnishings": {
    description: "Furnishings and visual aids for the home classroom environment",
    examples: ["desks", "chairs", "bookshelves", "educational posters", "visual supports", "whiteboards", "bulletin boards", "storage", "organizers"],
    school_equivalent: "Public school classrooms are fully furnished with desks, chairs, storage, bulletin boards, educational posters, visual aids, and organizational systems.",
  },
  "Learning Manipulatives/Creative Play Items": {
    description: "Hands-on learning tools and creative play items with educational purpose",
    examples: ["manipulatives", "building blocks", "puzzles", "STEM kits", "math manipulatives", "learning toys", "creative play", "stuffed animals"],
    school_equivalent: "Public school classrooms, especially K-5, are stocked with learning manipulatives, creative play items, and hands-on learning tools.",
  },
  "Elective Equipment": {
    description: "Equipment for elective courses such as cooking, art, music, shop",
    examples: ["cooking equipment", "art equipment", "music equipment", "stand mixer", "blender", "musical instruments", "easels", "pottery wheel"],
    school_equivalent: "Public schools provide fully equipped labs for home economics, art studios, music rooms, and shop classes. All equipment is provided at no cost.",
  },
  "Elective Supplies": {
    description: "Consumable supplies for elective courses",
    examples: ["cooking supplies", "art supplies", "music supplies", "measuring cups", "utensils", "mixing bowls", "paint", "clay", "fabric"],
    school_equivalent: "Public schools provide all consumable supplies for elective courses at no cost to students.",
  },
  "Technology": {
    description: "Computers, tablets, educational software, learning apps",
    examples: ["laptop", "tablet", "iPad", "software", "apps", "keyboard", "mouse", "monitor"],
    limits: "Market rate, every 24 months",
    school_equivalent: "Public schools provide computer labs, classroom devices, and educational software to all students.",
  },
  "Instructional Material": {
    description: "Broad category covering educational materials, curriculum, and learning aids",
    examples: ["curriculum", "educational materials", "learning aids", "educational games", "flash cards"],
    school_equivalent: "Public schools provide all instructional materials at no cost.",
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

// ─── Analysis ────────────────────────────────────────────────────────

export function analyzeDenials(txStore: TransactionStore): DisputeRecord[] {
  const disputes: DisputeRecord[] = [];

  for (const tx of txStore.transactions) {
    if (!tx.line_items) continue;

    for (const li of tx.line_items) {
      if (li.approval_status !== "Denied") continue;

      const analysis = analyzeItem(tx, li);
      disputes.push(analysis);
    }
  }

  return disputes;
}

function analyzeItem(tx: Transaction, li: LineItem): DisputeRecord {
  const itemAmount = li.cost * li.quantity + li.tax_shipping;
  const evidence: string[] = [];
  let classification: DisputeRecord["classification"] = "questionable";
  let argument = "";
  let schoolAccess = "";

  // Check if the item's category/type matches an approved category
  const matchedCategory = findMatchingCategory(li);

  if (matchedCategory) {
    const cat = APPROVED_CATEGORIES[matchedCategory];
    evidence.push(
      `Category "${matchedCategory}" is explicitly listed as approved in the Step Up scholarship documentation.`
    );
    evidence.push(
      `Documentation states: "${cat.description}"`
    );

    // Check if the specific item description matches known examples
    const itemLower = li.description.toLowerCase();
    const matchedExamples = cat.examples.filter(ex =>
      itemLower.includes(ex.toLowerCase()) || ex.toLowerCase().includes(itemLower.split("/")[0].trim().toLowerCase())
    );
    if (matchedExamples.length > 0) {
      evidence.push(
        `Item "${li.description}" matches approved examples: ${matchedExamples.join(", ")}`
      );
    }

    schoolAccess = cat.school_equivalent;
    classification = "improper";

    argument = buildArgument(li, cat, matchedCategory);
  } else {
    // Item doesn't match a known approved category — check if explicitly excluded
    const isExcluded = EXCLUDED_ITEMS.some(ex =>
      li.description.toLowerCase().includes(ex.toLowerCase())
    );

    if (isExcluded) {
      classification = "proper";
      evidence.push(`Item appears on the explicitly excluded list in documentation.`);
      argument = "This item is listed as not reimbursable under the program guidelines.";
    } else {
      classification = "questionable";
      evidence.push(
        `Item category "${li.type}" under "${li.category}" is not explicitly excluded from the program.`
      );
      evidence.push(
        `Under the "money follows the student" principle, items not explicitly excluded should be presumed eligible.`
      );
      argument = buildDefaultArgument(li);
      schoolAccess = "Public schools routinely provide equivalent items and services as part of the standard educational experience.";
    }
  }

  // Analyze the denial reason for accuracy
  if (li.denial_reason) {
    const reasonLower = li.denial_reason.toLowerCase();
    if (reasonLower.includes("not an approved expense") && matchedCategory) {
      evidence.push(
        `DISPUTE: Step Up stated "not an approved expense" but the item falls under the approved "${matchedCategory}" category. Their denial reason contradicts their own published guidelines.`
      );
    }
    if (reasonLower.includes("household item") && matchedCategory) {
      evidence.push(
        `DISPUTE: Step Up classified this as a "household item" but it is categorized under "${li.category} / ${li.type}" in their own portal — an educational classification, not household.`
      );
    }
    if (reasonLower.includes("not eligible") || reasonLower.includes("not an eligible")) {
      evidence.push(
        `Step Up bears the burden of demonstrating WHY this specific item is ineligible. A blanket "not eligible" statement without citing the specific exclusion or policy provision is insufficient.`
      );
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
    denial_reason: li.denial_reason,
    classification,
    documentation_evidence: evidence,
    legal_argument: argument,
    comparable_school_access: schoolAccess,
    notes: "",
  };
}

function findMatchingCategory(li: LineItem): string | null {
  // Direct type match
  if (APPROVED_CATEGORIES[li.type]) return li.type;

  // Fuzzy match on type
  const typeLower = li.type.toLowerCase();
  for (const [name, cat] of Object.entries(APPROVED_CATEGORIES)) {
    if (typeLower.includes(name.toLowerCase()) || name.toLowerCase().includes(typeLower)) {
      return name;
    }
    // Check if the item description matches any examples
    const descLower = li.description.toLowerCase();
    for (const ex of cat.examples) {
      if (descLower.includes(ex) || ex.includes(descLower.split("/")[0].trim().toLowerCase())) {
        return name;
      }
    }
  }

  // Match on category
  if (li.category === "Instructional Material") return "Instructional Material";

  return null;
}

function buildArgument(li: LineItem, cat: typeof APPROVED_CATEGORIES[string], categoryName: string): string {
  const lines = [
    `The Florida Step Up for Students scholarship operates on the principle that funding follows the student. ` +
    `The purpose is to provide scholarship families equivalent access to educational resources that public school students receive at no cost.`,
    ``,
    `"${li.description}" was submitted under the "${li.category} / ${li.type}" category. ` +
    `This falls squarely within the approved "${categoryName}" category as documented in the program's reimbursement guidelines.`,
    ``,
    `School equivalence: ${cat.school_equivalent}`,
    ``,
    `The denial states "not an approved expense" without citing which specific exclusion or policy provision applies. ` +
    `The burden is on Step Up for Students to identify the specific basis for exclusion, ` +
    `not on the parent to prove eligibility for an item that falls within an approved category.`,
  ];

  if (li.denial_reason?.toLowerCase().includes("household")) {
    lines.push(``);
    lines.push(
      `Step Up's characterization of this item as a "household item" is inconsistent with their own portal, ` +
      `which categorizes it under "${li.category} / ${li.type}" — an educational classification. ` +
      `An item used for education in a home-based learning environment is an educational expense, ` +
      `regardless of whether it could also have household use.`
    );
  }

  return lines.join("\n");
}

function buildDefaultArgument(li: LineItem): string {
  return [
    `The Florida Step Up for Students scholarship is designed so that funding follows the student. ` +
    `This item was submitted under "${li.category} / ${li.type}" for educational use.`,
    ``,
    `This item is not listed in the program's published exclusions. Under the presumption of eligibility, ` +
    `items not explicitly excluded should be approved unless Step Up can cite the specific policy provision that disqualifies them.`,
    ``,
    `A blanket "not approved" denial without citing the applicable exclusion is insufficient grounds for rejection.`,
  ].join("\n");
}

// ─── Reporting ───────────────────────────────────────────────────────

export function printDisputeReport(disputes: DisputeRecord[]): void {
  const improper = disputes.filter(d => d.classification === "improper");
  const questionable = disputes.filter(d => d.classification === "questionable");
  const proper = disputes.filter(d => d.classification === "proper");

  const totalLost = disputes.reduce((s, d) => s + d.item_amount, 0);
  const recoverableLost = [...improper, ...questionable].reduce((s, d) => s + d.item_amount, 0);

  console.log("\n=== Denial Dispute Analysis ===\n");
  console.log(`Total denied: ${disputes.length} items ($${totalLost.toFixed(2)})`);
  console.log(`Improper denials: ${improper.length} ($${improper.reduce((s, d) => s + d.item_amount, 0).toFixed(2)})`);
  console.log(`Questionable: ${questionable.length} ($${questionable.reduce((s, d) => s + d.item_amount, 0).toFixed(2)})`);
  console.log(`Proper denials: ${proper.length} ($${proper.reduce((s, d) => s + d.item_amount, 0).toFixed(2)})`);
  console.log(`Potentially recoverable: $${recoverableLost.toFixed(2)}`);

  if (improper.length > 0) {
    console.log("\n--- IMPROPER DENIALS (strong case for appeal) ---\n");
    for (const d of improper) {
      printDispute(d);
    }
  }

  if (questionable.length > 0) {
    console.log("\n--- QUESTIONABLE DENIALS (worth challenging) ---\n");
    for (const d of questionable) {
      printDispute(d);
    }
  }

  if (proper.length > 0) {
    console.log("\n--- PROPER DENIALS (likely valid) ---\n");
    for (const d of proper) {
      console.log(`  ${d.item_description} ($${d.item_amount.toFixed(2)}) — ${d.denial_reason?.substring(0, 80) || "(no reason)"}`);
    }
  }
}

function printDispute(d: DisputeRecord): void {
  console.log(`  #${d.transaction_id.replace("ema-", "")} | ${d.item_description}`);
  console.log(`  Category: ${d.item_category} / ${d.item_type}`);
  console.log(`  Amount: $${d.item_amount.toFixed(2)} | Vendor: ${d.item_vendor}`);
  console.log(`  Their reason: ${d.denial_reason?.substring(0, 100) || "(none stated)"}`);
  console.log(`  Classification: ${d.classification.toUpperCase()}`);
  console.log(`  Evidence:`);
  for (const e of d.documentation_evidence) {
    console.log(`    - ${e}`);
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
