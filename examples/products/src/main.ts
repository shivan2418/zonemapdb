import { connect } from "./zonedb/client.js";
import type { ProductsCategory } from "./zonedb/schema.js";

const db = connect();

// `category` is an enum-like field, so codegen exports its value union — no hand-rolled
// `type Category = "Kitchen" | …` to keep in sync with the data.
const CATEGORIES: readonly ProductsCategory[] = [
  "Electronics",
  "Fitness",
  "Garden",
  "Kitchen",
  "Office",
  "Outdoors",
  "Stationery",
  "Toys",
];

async function runLookup(sku: string) {
  const el = document.getElementById("lookup-result")!;
  const record = await db.products.get(sku);
  el.textContent = record
    ? `${record.name} — $${record.price} (${record.category}), ${record.inStock ? "in stock" : "out of stock"}`
    : `no product with SKU "${sku}"`;
}

async function runDiscounted() {
  const el = document.getElementById("discounted-results") as HTMLUListElement;
  const { records } = await db.products.findMany({
    where: { inStock: { equals: true }, discountPct: { exists: true } },
    orderBy: { price: "asc" },
    limit: 10,
  });
  el.innerHTML = "";
  for (const r of records) {
    const li = document.createElement("li");
    li.textContent = `${r.name} — $${r.price} (${r.discountPct}% off), ${r.category}`;
    el.appendChild(li);
  }
}

async function runByCategory(category: ProductsCategory) {
  const el = document.getElementById("category-results") as HTMLUListElement;
  // `equals` is narrowed to ProductsCategory, so a typo here is a compile error.
  const { records } = await db.products.findMany({
    where: { category: { equals: category } },
    orderBy: { price: "asc" },
    limit: 5,
  });
  el.innerHTML = "";
  for (const r of records) {
    const li = document.createElement("li");
    li.textContent = `${r.name} — $${r.price}`;
    el.appendChild(li);
  }
}

function buildCategoryPicker() {
  const select = document.getElementById("category-select") as HTMLSelectElement;
  for (const category of CATEGORIES) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    void runByCategory(select.value as ProductsCategory);
  });
}

async function main() {
  // Wire every listener synchronously, before the first await: a submit that lands while the
  // initial queries are still in flight would otherwise fall through to a native form submit and
  // reload the page.
  document.getElementById("lookup-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void runLookup((document.getElementById("lookup-input") as HTMLInputElement).value);
  });
  buildCategoryPicker();

  const { count } = await db.products.count();
  document.getElementById("total-count")!.textContent = `${count} products in the catalog`;

  await runLookup((document.getElementById("lookup-input") as HTMLInputElement).value);
  await runDiscounted();
  await runByCategory(CATEGORIES[0]!);
}

void main();
