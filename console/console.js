"use strict";

const byId = (id) => document.getElementById(id);
const services = [
  { name: "Amazon S3", icon: "S3", description: "Browse buckets and object metadata", href: "#s3" },
  { name: "Amazon SQS", icon: "SQS", description: "Console support planned" },
  { name: "Amazon DynamoDB", icon: "DDB", description: "Console support planned" },
];

function element(tag, content, parent) {
  const node = document.createElement(tag);
  node.textContent = content;
  parent.append(node);
  return node;
}

function link(parent, text, href) {
  const anchor = element("a", text, parent);
  anchor.href = href;
  return anchor;
}

function renderCatalog() {
  const catalog = byId("catalog");
  for (const service of services) {
    const card = element("article", "", catalog);
    card.className = "card";
    const mark = element("span", service.icon, card);
    mark.className = "service-mark";
    mark.setAttribute("aria-hidden", "true");
    const content = element("div", "", card);
    const heading = element("h3", service.href ? "" : service.name, content);
    if (service.href) link(heading, service.name, service.href);
    element("p", service.description, content);
  }
}

const searchBox = byId("search");
const searchResults = byId("search-results");

function renderSearch() {
  const query = searchBox.value.trim().toLowerCase();
  searchResults.replaceChildren();
  searchResults.hidden = !query;
  if (!query) return;
  for (const service of services.filter(({ name }) => name.toLowerCase().includes(query))) {
    if (service.href) {
      link(searchResults, service.name, service.href).addEventListener("click", () => {
        searchBox.value = "";
        renderSearch();
      });
    } else {
      element("p", service.name + " · Planned", searchResults);
    }
  }
  if (!searchResults.children.length) element("p", "No matching services.", searchResults);
}

function s3Error(result, fallback) {
  const message = result.error || fallback;
  return new Error(result.code ? `${message} (${result.code} · ${result.operation})` : message);
}

async function request(path, signal) {
  const response = await fetch(path, { signal });
  const data = await response.json();
  if (!response.ok) throw s3Error(data, "Console request failed.");
  return data;
}

async function checkHealth() {
  const connection = byId("connection");
  try {
    const data = await request("/api/health", AbortSignal.timeout(5000));
    byId("endpoint").textContent = data.endpoint;
    byId("storage-endpoint").textContent = data.endpoint;
    connection.textContent = data.ready ? "Emulator ready" : "Emulator unavailable";
    connection.classList.toggle("ready", data.ready);
  } catch {
    connection.textContent = "Console server unavailable";
    connection.classList.remove("ready");
  }
  byId("home-connection").textContent = connection.textContent;
  byId("storage-connection").textContent = connection.textContent;
}

function objectPath(bucket, region, prefix = "") {
  return "#s3?" + new URLSearchParams({ bucket, region, prefix });
}

function displayDate(date) {
  return date ? new Date(date).toLocaleString() : "—";
}

let navCollapsed = false;
function renderNavigation(isS3) {
  byId("service-bar").hidden = !isS3;
  byId("main-nav").hidden = isS3 && navCollapsed;
  byId("toggle-nav").setAttribute("aria-expanded", String(!navCollapsed));
}

byId("toggle-nav").addEventListener("click", () => {
  navCollapsed = !navCollapsed;
  renderNavigation(true);
});

let activeRequest;
let tokens = [""];
let pageIndex = 0;
let nextToken = "";

function filterResources() {
  const query = byId("resource-filter").value.trim().toLowerCase();
  let visible = 0;
  const rows = byId("rows").children;
  for (const row of rows) {
    row.hidden = !row.cells[0].textContent.toLowerCase().includes(query);
    if (!row.hidden) visible++;
  }
  byId("table").hidden = visible === 0;
  byId("resource-count").textContent = query ? `${visible} of ${rows.length} on this page` : `${visible} on this page`;
  byId("notice").textContent = visible ? "" : query ? "No matches on this page." : byId("notice").dataset.empty;
}

function showObject(bucket, item, region) {
  const fields = byId("detail-fields");
  fields.replaceChildren();
  const metadata = {
    Key: item.Key,
    "S3 URI": `s3://${bucket}/${item.Key}`,
    Size: `${item.Size.toLocaleString()} B`,
    "Last modified": displayDate(item.LastModified),
    "Storage class": item.StorageClass,
    ETag: item.ETag,
  };
  for (const [label, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    element("dt", label, fields);
    element("dd", value, fields);
  }
  const target = { bucket, key: item.Key, region };
  byId("download-error").hidden = true;
  byId("download-object").onclick = () => downloadObject(target);
  byId("delete-object").onclick = () => {
    byId("object-detail").close();
    openAction("delete-object", target);
  };
  byId("object-detail").showModal();
}

async function renderRoute(reset = false) {
  activeRequest?.abort();
  const [route, query] = location.hash.slice(1).split("?", 2);
  const isS3 = route === "s3";
  renderNavigation(isS3);
  byId("home").hidden = isS3;
  byId("storage").hidden = !isS3;
  byId("s3-nav").hidden = !isS3;
  byId(isS3 ? "home-link" : "s3-link").removeAttribute("aria-current");
  byId(isS3 ? "s3-link" : "home-link").setAttribute("aria-current", "page");
  if (!isS3) return;

  if (reset) {
    tokens = [""];
    pageIndex = 0;
  }
  const params = new URLSearchParams(query);
  const bucket = params.get("bucket");
  const prefix = params.get("prefix") || "";
  const region = params.get("region") || byId("region").value;
  const regionSelect = byId("region");
  if (bucket && params.has("region")) {
    if (![...regionSelect.options].some((option) => option.value === region)) {
      regionSelect.add(new Option(region, region));
    }
    regionSelect.value = region;
  }
  const breadcrumbs = byId("breadcrumbs");
  breadcrumbs.replaceChildren();
  link(breadcrumbs, "Console home", "#home");
  element("span", "/", breadcrumbs);
  link(breadcrumbs, "Amazon S3", "#s3");
  if (bucket) {
    element("span", "/", breadcrumbs);
    link(breadcrumbs, bucket, objectPath(bucket, region));
    if (prefix) {
      const parentPrefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
      element("span", "/", breadcrumbs);
      element("span", prefix, breadcrumbs);
      link(breadcrumbs, "Up one level", objectPath(bucket, region, parentPrefix));
    }
  }
  byId("title").textContent = bucket || "Buckets";
  byId("listing-scope").textContent = bucket ? region : "All emulator regions";
  byId("workspace-description").textContent = bucket ? `Bucket region: ${region}` : "Browse buckets in your local emulator.";
  byId("resource-title").textContent = bucket ? "Objects" : "General purpose buckets";
  byId("resource-count").textContent = "";
  byId("create-bucket").hidden = Boolean(bucket);
  byId("upload-object").hidden = !bucket;
  byId("delete-bucket").hidden = !bucket;
  byId("upload-object").onclick = () => openAction("upload", { bucket, region }, prefix);
  byId("delete-bucket").onclick = () => openAction("delete-bucket", { bucket, region });
  const filter = byId("resource-filter");
  const filterLabel = bucket ? "Filter keys on this page" : "Filter bucket names on this page";
  filter.placeholder = filterLabel;
  filter.setAttribute("aria-label", filterLabel);
  filter.disabled = true;
  filter.value = "";
  const table = byId("table");
  const notice = byId("notice");
  table.hidden = true;
  byId("pagination").hidden = true;
  notice.textContent = "Loading…";

  const requestParams = new URLSearchParams({ region });
  if (bucket) {
    requestParams.set("bucket", bucket);
    requestParams.set("prefix", prefix);
  }
  if (tokens[pageIndex]) requestParams.set("token", tokens[pageIndex]);
  const controller = new AbortController();
  activeRequest = controller;

  try {
    const data = await request((bucket ? "/api/objects?" : "/api/buckets?") + requestParams, controller.signal);
    if (controller.signal.aborted) return;
    const columns = byId("columns");
    const rows = byId("rows");
    columns.replaceChildren();
    rows.replaceChildren();
    const header = element("tr", "", columns);
    for (const name of bucket ? ["Key / prefix", "Size", "Last modified"] : ["Name", "Region", "Created"]) {
      element("th", name, header).scope = "col";
    }
    for (const item of data.Buckets || []) {
      const row = element("tr", "", rows);
      link(element("td", "", row), item.Name, objectPath(item.Name, item.BucketRegion || region));
      element("td", item.BucketRegion || "—", row);
      element("td", displayDate(item.CreationDate), row);
    }
    for (const item of data.CommonPrefixes || []) {
      const row = element("tr", "", rows);
      link(element("td", "", row), item.Prefix, objectPath(bucket, region, item.Prefix));
      element("td", "—", row);
      element("td", "—", row);
    }
    for (const item of data.Contents || []) {
      const row = element("tr", "", rows);
      const open = element("button", item.Key, element("td", "", row));
      open.type = "button";
      open.className = "object-link";
      open.addEventListener("click", () => showObject(bucket, item, region));
      element("td", `${item.Size.toLocaleString()} B`, row);
      element("td", displayDate(item.LastModified), row);
    }

    notice.dataset.empty = bucket ? "No objects in this prefix." : "No buckets found.";
    filter.disabled = rows.children.length === 0;
    filterResources();
    nextToken = (bucket ? data.NextContinuationToken : data.ContinuationToken) || "";
    byId("pagination").hidden = !nextToken && pageIndex === 0;
    byId("previous").disabled = pageIndex === 0;
    byId("next").disabled = !nextToken;
    byId("page").textContent = `Page ${pageIndex + 1}`;
  } catch (error) {
    if (!controller.signal.aborted) notice.textContent = error.message;
  }
}

function s3ActionUrl(action, target) {
  return "/api/" + action + "?" + new URLSearchParams(target);
}

async function downloadObject(target) {
  const button = byId("download-object");
  const errorNotice = byId("download-error");
  button.disabled = true;
  errorNotice.hidden = true;
  try {
    const response = await fetch(s3ActionUrl("download", target));
    if (!response.ok) throw s3Error(await response.json(), "Could not download the object.");
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = target.key.split("/").at(-1) || "object";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    errorNotice.textContent = error.message;
    errorNotice.hidden = false;
  } finally {
    button.disabled = false;
  }
}

const actionDialog = byId("action-dialog");
const actionForm = byId("action-form");
const actionError = byId("action-error");
const uploadFile = byId("upload-file");
const uploadKey = byId("upload-key");
const submitAction = byId("submit-action");
const cancelAction = byId("cancel-action");
let pendingAction;

function openAction(action, target, prefix = "") {
  pendingAction = { action, target, prefix };
  const upload = action === "upload";
  const title = upload ? "Upload object" : action === "delete-bucket" ? "Delete bucket" : "Delete object";
  actionForm.reset();
  actionError.hidden = true;
  byId("action-title").textContent = title;
  submitAction.textContent = title;
  submitAction.className = upload ? "primary" : "danger";
  byId("upload-fields").hidden = !upload;
  uploadFile.required = uploadKey.required = upload;
  byId("action-description").textContent = upload
    ? `Upload to ${target.bucket}. An existing object at the same key may be replaced. Files up to 64 MiB.`
    : action === "delete-bucket"
      ? `Delete ${target.bucket}? The bucket must be empty.`
      : `Delete s3://${target.bucket}/${target.key}?`;
  actionDialog.showModal();
}

uploadFile.addEventListener("change", () => {
  if (uploadFile.files[0]) uploadKey.value = pendingAction.prefix + uploadFile.files[0].name;
});
cancelAction.addEventListener("click", () => actionDialog.close());
actionDialog.addEventListener("cancel", (event) => {
  if (submitAction.disabled) event.preventDefault();
});
actionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { action, target } = pendingAction;
  const upload = action === "upload";
  const destination = upload ? { ...target, key: uploadKey.value } : target;
  const body = upload ? uploadFile.files[0] : undefined;
  actionError.hidden = true;
  submitAction.disabled = cancelAction.disabled = true;
  try {
    if (body && body.size > 64 * 1024 * 1024) throw new Error("Choose a file up to 64 MiB.");
    const response = await fetch(s3ActionUrl(action, destination), { method: "POST", body });
    if (!response.ok) {
      const result = await response.json();
      throw s3Error(result, "S3 request failed.");
    }
    actionDialog.close();
    if (action === "delete-bucket") location.hash = "#s3";
    else renderRoute(true);
  } catch (error) {
    actionError.textContent = error.message;
    actionError.hidden = false;
  } finally {
    submitAction.disabled = cancelAction.disabled = false;
  }
});

const bucketDialog = byId("bucket-form-dialog");
const bucketForm = byId("bucket-form");
const bucketError = byId("bucket-form-error");
const submitBucket = byId("submit-create");
const cancelCreate = byId("cancel-create");
let creationRegion;

byId("create-bucket").addEventListener("click", () => {
  bucketForm.reset();
  bucketError.hidden = true;
  creationRegion = byId("region").value;
  byId("bucket-form-region").textContent = `Region: ${creationRegion}`;
  bucketDialog.showModal();
});
cancelCreate.addEventListener("click", () => bucketDialog.close());
bucketDialog.addEventListener("cancel", (event) => {
  if (submitBucket.disabled) event.preventDefault();
});
bucketForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const bucket = byId("bucket-name").value.trim();
  bucketError.hidden = true;
  submitBucket.disabled = cancelCreate.disabled = true;
  try {
    const response = await fetch("/api/buckets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket, region: creationRegion }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw s3Error(result, "Could not create bucket.");
    }
    bucketDialog.close();
    location.hash = objectPath(bucket, creationRegion);
  } catch (error) {
    bucketError.textContent = error instanceof SyntaxError ? "Restart the console server to enable bucket creation." : error.message;
    bucketError.hidden = false;
  } finally {
    submitBucket.disabled = cancelCreate.disabled = false;
  }
});

searchBox.addEventListener("input", renderSearch);
searchBox.addEventListener("focus", renderSearch);
document.querySelector(".service-search").addEventListener("focusout", (event) => {
  if (!event.currentTarget.contains(event.relatedTarget)) searchResults.hidden = true;
});
document.querySelector(".service-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    searchBox.focus();
    searchResults.hidden = true;
  }
  if (event.key === "Enter" && event.target === searchBox && !searchResults.hidden) {
    searchResults.querySelector("a")?.click();
  }
});
byId("resource-filter").addEventListener("input", filterResources);
byId("refresh").addEventListener("click", () => { checkHealth(); renderRoute(true); });
byId("region").addEventListener("change", (event) => {
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const bucket = params.get("bucket");
  if (bucket) {
    location.hash = objectPath(bucket, event.target.value, params.get("prefix") || "");
  } else {
    renderRoute(true);
  }
});
byId("previous").addEventListener("click", () => { pageIndex--; renderRoute(); });
byId("next").addEventListener("click", () => { tokens[++pageIndex] = nextToken; renderRoute(); });
window.addEventListener("hashchange", () => renderRoute(true));
renderCatalog();
renderRoute(true);
checkHealth();
setInterval(checkHealth, 10000);
