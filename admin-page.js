(function () {
  const CATALOGS = [
    { id: 1, sourcePdf: "01_Staple_Model_Catalog.pdf", title: "Staple Model Catalog" },
    { id: 2, sourcePdf: "02_Milana_Man_Premium_Collection.pdf", title: "Milana Man Premium Collection" },
    { id: 3, sourcePdf: "03_Kindergarten_Set.pdf", title: "Kindergarten Set" },
    { id: 4, sourcePdf: "04_Milana_Products_in_Stock.pdf", title: "Milana Products in Stock" }
  ];

  const config = window.MILANA_CONFIG || {};
  const LEGACY_HIDDEN_STATUS = "admin_hidden";
  const params = new URLSearchParams(window.location.search);
  const catalogId = Number(params.get("id")) || 1;
  const catalog = CATALOGS.find((item) => item.id === catalogId) || CATALOGS[0];
  const state = {
    session: readSession(),
    products: [],
    filtered: [],
    editing: null,
    creating: false
  };

  const loginPanel = document.getElementById("loginPanel");
  const loginForm = document.getElementById("loginForm");
  const loginMessage = document.getElementById("loginMessage");
  const workspace = document.getElementById("adminWorkspace");
  const logoutButton = document.getElementById("logoutButton");
  const titleEl = document.getElementById("catalogTitle");
  const numberEl = document.getElementById("catalogNumber");
  const gridEl = document.getElementById("productGrid");
  const countEl = document.getElementById("productCount");
  const searchEl = document.getElementById("productSearch");
  const statusEl = document.getElementById("status");
  const editModal = document.getElementById("editModal");
  const editForm = document.getElementById("editForm");
  const editMessage = document.getElementById("editMessage");
  const addProductButton = document.getElementById("addProductButton");

  titleEl.textContent = catalog.title;
  numberEl.textContent = "Catalog 0" + catalog.id;
  document.querySelectorAll("[data-catalog-link]").forEach((link) => {
    link.classList.toggle("active", Number(link.dataset.catalogLink) === catalog.id);
  });

  loginForm.addEventListener("submit", handleLogin);
  logoutButton.addEventListener("click", logout);
  addProductButton.addEventListener("click", openCreator);
  searchEl.addEventListener("input", applySearch);
  gridEl.addEventListener("click", (event) => {
    const visibilityButton = event.target.closest("[data-visibility-id]");
    if (visibilityButton) {
      toggleVisibility(visibilityButton.dataset.visibilityId);
      return;
    }

    const button = event.target.closest("[data-edit-id]");
    if (!button) {
      return;
    }
    openEditor(button.dataset.editId);
  });
  document.getElementById("closeEdit").addEventListener("click", closeEditor);
  document.getElementById("cancelEdit").addEventListener("click", closeEditor);
  editModal.addEventListener("click", (event) => {
    if (event.target === editModal) {
      closeEditor();
    }
  });
  editForm.addEventListener("submit", saveEditor);

  if (state.session) {
    restoreSession().catch((error) => {
      logout();
      loginMessage.textContent = error.message;
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    loginMessage.textContent = "Checking login...";

    try {
      requireSupabaseConfig();
      const email = document.getElementById("adminEmail").value.trim();
      const password = document.getElementById("adminPassword").value;
      const response = await fetch(`${baseUrl()}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: config.supabasePublishableKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) {
        const details = await readResponseMessage(response);
        if (details.includes("invalid_credentials")) {
          throw new Error("Wrong email/password, or this user is not created in Supabase Auth yet.");
        }
        throw new Error(details || "Login failed.");
      }

      state.session = await response.json();
      saveSession(state.session);
      const admin = await checkAdmin();
      if (!admin) {
        throw new Error("This account is not allowed to edit Milana products.");
      }

      showWorkspace();
      await loadProducts();
    } catch (error) {
      logout();
      loginMessage.textContent = error.message;
    }
  }

  async function restoreSession() {
    const admin = await checkAdmin();
    if (!admin) {
      throw new Error("This account is not allowed to edit Milana products.");
    }

    showWorkspace();
    await loadProducts();
  }

  async function checkAdmin() {
    const response = await supabaseFetch("/rest/v1/rpc/is_milana_admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: "{}"
    });

    if (!response.ok) {
      const details = await readResponseMessage(response);
      throw new Error(details || "Admin security is not set up in Supabase yet.");
    }

    return response.json();
  }

  async function loadProducts() {
    showStatus("Loading products...");
    const localProducts = await readProductsFromLocalJson().catch(() => []);
    const supabaseProducts = await readProductsFromSupabase().catch(() => []);
    const supabaseByKey = new Map(supabaseProducts.map((product) => [productKey(product), product]));
    const mergedKeys = new Set();

    state.products = localProducts.map((product) => {
      mergedKeys.add(productKey(product));
      const supabaseProduct = supabaseByKey.get(productKey(product));
      if (!supabaseProduct) {
        return product;
      }

      return normalizeProductImageState(Object.assign({}, product, supabaseProduct, {
        local_only: false
      }));
    });

    supabaseProducts.forEach((product) => {
      const key = productKey(product);
      if (!mergedKeys.has(key)) {
        state.products.push(normalizeProductImageState(Object.assign({}, product, { local_only: false })));
      }
    });
    const manualProducts = await readManualProductsFromStorage().catch(() => []);
    manualProducts.forEach((product) => {
      const key = productKey(product);
      const existingIndex = state.products.findIndex((item) => productKey(item) === key);
      if (existingIndex >= 0) {
        state.products[existingIndex] = normalizeProductImageState(Object.assign({}, state.products[existingIndex], product));
      } else {
        mergedKeys.add(key);
        state.products.push(normalizeProductImageState(product));
      }
    });

    state.products = removeCatalog4ImagePlaceholders(state.products);
    state.products.sort(compareProducts);
    state.filtered = state.products.slice();
    hideStatus();
    renderProducts();
  }

  async function readProductsFromSupabase() {
    const source = encodeURIComponent(catalog.sourcePdf);
    const table = encodeURIComponent(config.table || "milana_products");
    const select = [
      "id",
      "source_system",
      "run_id",
      "source_pdf",
      "page",
      "card_index",
      "model_code",
      "product_code",
      "material_type",
      "price",
      "currency",
      "image_url",
      "image_storage_bucket",
      "image_storage_path",
      "extraction_status",
      "is_visible",
      "native_text",
      "ocr_text",
      "combined_text"
    ].join(",");
    let response = await supabaseFetch(
      `/rest/v1/${table}?select=${select}&source_pdf=eq.${source}&order=page.asc,card_index.asc`
    );

    if (!response.ok) {
      const fallbackSelect = select.replace(",material_type", "").replace(",is_visible", "");
      response = await supabaseFetch(
        `/rest/v1/${table}?select=${fallbackSelect}&source_pdf=eq.${source}&order=page.asc,card_index.asc`
      );
    }

    if (!response.ok) {
      throw new Error("Products could not be loaded from Supabase.");
    }

    const products = await response.json();
    if (!products.length) {
      throw new Error("Supabase returned no visible products.");
    }

    return products;
  }

  async function readProductsFromLocalJson() {
    const response = await fetch(config.localJson || "outputs/catalog_processing/milana_products_latest.json", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Products could not be loaded from Supabase or local JSON.");
    }

    const products = await response.json();
    return products
      .filter((item) => item && item.source_pdf === catalog.sourcePdf)
      .sort((a, b) => Number(a.page || 0) - Number(b.page || 0) || Number(a.card_index || 0) - Number(b.card_index || 0))
      .map((item) => Object.assign({}, item, {
        id: item.id || `${item.source_pdf}:${item.page}:${item.card_index}`,
        is_visible: item.is_visible !== false,
        local_only: true
      }));
  }

  function productKey(product) {
    return [
      product.source_pdf || "",
      Number(product.page || 0),
      Number(product.card_index || 0)
    ].join(":");
  }

  function normalizeProductImageState(product) {
    if (hasProductImage(product)) {
      return Object.assign({}, product, { image_missing: false });
    }

    return product;
  }

  function hasProductImage(product) {
    return Boolean(product && (product.image_url || product.image_path || product.image_storage_path));
  }

  function removeCatalog4ImagePlaceholders(products) {
    if (catalog.id !== 4) {
      return products;
    }

    const imageKeys = new Set();
    products.forEach((product) => {
      const key = productDuplicateKey(product);
      if (key && hasProductImage(product)) {
        imageKeys.add(key);
      }
    });

    return products.filter((product) => {
      const key = productDuplicateKey(product);
      return hasProductImage(product) || !key || !imageKeys.has(key);
    });
  }

  function productDuplicateKey(product) {
    if (!product || !product.source_pdf || !product.model_code || !product.product_code) {
      return "";
    }

    return [product.source_pdf, product.model_code, product.product_code].join(":");
  }

  function compareProducts(a, b) {
    return Number(a.page || 0) - Number(b.page || 0) || Number(a.card_index || 0) - Number(b.card_index || 0);
  }

  function isVisible(product) {
    return product.is_visible !== false && product.extraction_status !== LEGACY_HIDDEN_STATUS;
  }

  function nextProductPosition() {
    const maxPage = state.products.reduce((max, product) => Math.max(max, Number(product.page || 0)), 0);
    return {
      page: maxPage + 1,
      cardIndex: 1
    };
  }

  function renderProducts() {
    countEl.textContent = state.filtered.length + (state.filtered.length === 1 ? " item" : " items");
    if (!state.filtered.length) {
      gridEl.innerHTML = '<div class="empty">No matching products.</div>';
      return;
    }

    gridEl.innerHTML = state.filtered.map(productCardMarkup).join("");
  }

  function productCardMarkup(product) {
    const model = escapeHtml(product.model_code || product.product_code || "Model");
    const code = escapeHtml(product.product_code || product.model_code || "");
      const image = resolveImageUrl(product);
      const price = escapeHtml(formatPrice(product.price, product.currency));
      const visible = isVisible(product);
      return `
        <article class="product-card${visible ? "" : " is-off"}">
          ${visible ? "" : '<span class="visibility-badge">Off</span>'}
          <button class="edit-button" type="button" data-edit-id="${escapeAttribute(product.id)}">Edit</button>
          <button
            class="visibility-switch ${visible ? "is-on" : "is-off"}${product.saving_visibility ? " is-saving" : ""}"
            type="button"
            data-visibility-id="${escapeAttribute(product.id)}"
            aria-label="${visible ? "Turn client visibility off" : "Turn client visibility on"}"
            aria-pressed="${visible ? "true" : "false"}"
            ${product.saving_visibility ? "disabled" : ""}>
            <span class="switch-label">${product.saving_visibility ? "..." : visible ? "ON" : "OFF"}</span>
            <span class="switch-knob" aria-hidden="true"></span>
          </button>
          <div class="product-image">
            ${image ? `<img src="${escapeAttribute(image)}" alt="${model}" loading="lazy">` : '<div class="missing-image">No image</div>'}
          </div>
          <div class="product-info">
            <div class="model-row">
              <h2 class="model">${model}</h2>
              <p class="price">${price}</p>
            </div>
            <p class="code">Code ${code}</p>
          </div>
        </article>
      `;
  }

  function openEditor(id) {
    const product = state.products.find((item) => String(item.id) === String(id));
    if (!product) {
      return;
    }

    state.editing = product;
    state.creating = false;
    document.getElementById("editEyebrow").textContent = "Edit Product";
    document.getElementById("editTitle").textContent = product.model_code || product.product_code || "Product";
    document.getElementById("editModel").value = product.model_code || "";
    document.getElementById("editCode").value = product.product_code || "";
    document.getElementById("editMaterial").value = materialType(product);
    document.getElementById("editPrice").value = product.price || "";
    document.getElementById("editImageUrl").value = product.image_url || "";
    document.getElementById("editImageFile").value = "";
    document.getElementById("editVisible").checked = isVisible(product);
    editMessage.textContent = "";
    editModal.hidden = false;
  }

  function openCreator() {
    const nextPosition = nextProductPosition();
    state.creating = true;
    state.editing = {
      id: "__new_product__",
      source_pdf: catalog.sourcePdf,
      page: nextPosition.page,
      card_index: nextPosition.cardIndex,
      currency: "USD",
      is_visible: true,
      local_only: false
    };

    document.getElementById("editEyebrow").textContent = "Add Model";
    document.getElementById("editTitle").textContent = "New model";
    document.getElementById("editModel").value = "";
    document.getElementById("editCode").value = "";
    document.getElementById("editMaterial").value = "Suprem";
    document.getElementById("editPrice").value = "";
    document.getElementById("editImageUrl").value = "";
    document.getElementById("editImageFile").value = "";
    document.getElementById("editVisible").checked = true;
    editMessage.textContent = "";
    editModal.hidden = false;
  }

  function closeEditor() {
    editModal.hidden = true;
    state.editing = null;
    state.creating = false;
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!state.editing) {
      return;
    }

    const saveButton = document.getElementById("saveEdit");
    saveButton.disabled = true;
    editMessage.textContent = "Saving...";

    try {
      const modelCode = cleanValue(document.getElementById("editModel").value);
      const productCode = cleanValue(document.getElementById("editCode").value);
      const material = cleanValue(document.getElementById("editMaterial").value) || "Suprem";
      const priceInput = parsePriceInput(document.getElementById("editPrice").value);
      const imageUrlField = cleanValue(document.getElementById("editImageUrl").value);
      const file = document.getElementById("editImageFile").files[0];
      const visible = document.getElementById("editVisible").checked;
      if (!modelCode && !productCode) {
        throw new Error("Add a model number or product code.");
      }
      if (!priceInput.value) {
        throw new Error("Add a price.");
      }

      let imageUrl = imageUrlField;
      let imageStorageBucket = state.editing.image_storage_bucket || null;
      let imageStoragePath = state.editing.image_storage_path || null;
      if (file) {
        try {
          const uploaded = await uploadImage(file);
          imageUrl = uploaded.url;
          imageStorageBucket = uploaded.bucket;
          imageStoragePath = uploaded.path;
        } catch (uploadError) {
          imageUrl = await fileToDataUrl(file);
          imageStorageBucket = null;
          imageStoragePath = null;
          console.warn(uploadError);
        }
      }
      const hasEditedImage = Boolean(imageUrl || imageStoragePath);

      const payload = {
        model_code: modelCode || null,
        product_code: productCode || null,
        material_type: material,
        price: priceInput.value,
        currency: state.editing.currency || "USD",
        image_url: imageUrl || null,
        image_storage_bucket: imageStorageBucket,
        image_storage_path: imageStoragePath,
        image_missing: hasEditedImage ? false : state.editing.image_missing === true,
        is_visible: visible
      };
      const databasePayload = databaseProductPayload(payload);

      if (state.creating) {
        const created = priceInput.isNumeric ? await createProduct(databasePayload) : await createManualProduct(payload);
        if (hasEditedImage) {
          created.image_missing = false;
        }
        state.products.push(created);
        state.products.sort(compareProducts);
      } else {
        const updated = !priceInput.isNumeric
          ? await updateManualProduct(state.editing, payload)
          : state.editing.manual_storage
          ? await updateManualProduct(state.editing, payload)
          : state.editing.local_only
            ? payload
            : await patchProduct(databasePayload);
        if (priceInput.isNumeric && !state.editing.manual_storage && state.editing.source_system !== "milana_manual_admin") {
          await saveOverride(databasePayload);
        }
        Object.assign(state.editing, updated || payload);
        if (hasEditedImage) {
          state.editing.image_missing = false;
        }
      }

      applySearch();
      editMessage.textContent = "Saved.";
      closeEditor();
    } catch (error) {
      editMessage.textContent = error.message;
    } finally {
      saveButton.disabled = false;
    }
  }

  async function uploadImage(file) {
    const bucket = config.imageBucket || "product-images";
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "product.jpg";
    const objectPath = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const response = await supabaseFetch(
      `/storage/v1/object/${encodeURIComponent(bucket)}/${pathEncode(objectPath)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "x-upsert": "true"
        },
        body: file
      }
    );

    if (!response.ok) {
      const details = await readResponseMessage(response);
      throw new Error(details || "Picture upload failed.");
    }

    return {
      bucket,
      path: objectPath,
      url: `${baseUrl()}/storage/v1/object/public/${encodeURIComponent(bucket)}/${pathEncode(objectPath)}`
    };
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Picture upload failed."));
      reader.readAsDataURL(file);
    });
  }

  async function readManualProductsFromStorage() {
    if (!config.supabaseUrl) {
      return [];
    }

    const response = await fetch(manualProductsStorageUrl(), {
      cache: "no-store"
    });
    if (response.status === 404 || !response.ok) {
      return [];
    }

    const products = await response.json();
    return Array.isArray(products)
      ? products
        .filter((product) => product && product.source_pdf === catalog.sourcePdf)
        .map(normalizeManualProduct)
      : [];
  }

  async function saveManualProductToStorage(row) {
    const products = await readManualProductsFromStorage().catch(() => []);
    const manualProduct = normalizeManualProduct(Object.assign({}, row, {
      id: row.id || manualProductId(row),
      source_system: "milana_manual_admin",
      manual_storage: true,
      local_only: false
    }));
    const nextProducts = products
      .filter((product) => productKey(product) !== productKey(manualProduct))
      .concat(manualProduct)
      .sort(compareProducts);

    await writeManualProductsToStorage(nextProducts);
    return manualProduct;
  }

  async function createManualProduct(payload) {
    const position = {
      page: Number(state.editing.page || 0) || nextProductPosition().page,
      card_index: Number(state.editing.card_index || 0) || nextProductPosition().cardIndex
    };
    const row = Object.assign({}, payload, {
      id: "__manual_storage__",
      source_system: "milana_manual_admin",
      run_id: "manual-storage-" + new Date().toISOString(),
      catalog_date: new Date().toISOString().slice(0, 10),
      source_pdf: catalog.sourcePdf,
      source_pdf_path: null,
      page: position.page,
      card_index: position.card_index,
      bbox: null,
      extraction_status: payload.is_visible === false ? LEGACY_HIDDEN_STATUS : "manual",
      native_text: null,
      ocr_text: null,
      combined_text: null,
      image_sha256: null,
      image_fingerprint: null,
      embedding_model: null,
      embedding_path: null,
      embedding_preview: null
    });

    return saveManualProductToStorage(row);
  }

  async function updateManualProduct(product, payload) {
    const products = await readManualProductsFromStorage().catch(() => []);
    const updated = normalizeManualProduct(Object.assign({}, product, payload, {
      id: product.id || manualProductId(product),
      manual_storage: true,
      local_only: false
    }));
    const nextProducts = products
      .filter((item) => productKey(item) !== productKey(product))
      .concat(updated)
      .sort(compareProducts);

    await writeManualProductsToStorage(nextProducts);
    return updated;
  }

  async function writeManualProductsToStorage(products) {
    const bucket = config.imageBucket || "product-images";
    const response = await supabaseFetch(
      `/storage/v1/object/${encodeURIComponent(bucket)}/${pathEncode(manualProductsStoragePath())}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-upsert": "true"
        },
        body: JSON.stringify(products)
      }
    );

    if (!response.ok) {
      const details = await readResponseMessage(response);
      throw new Error(details || "Manual model could not be saved to Storage.");
    }
  }

  function normalizeManualProduct(product) {
    const hasImage = Boolean(product.image_url || product.image_path || product.image_storage_path);
    return Object.assign({}, product, {
      id: product.id || manualProductId(product),
      source_pdf: product.source_pdf || catalog.sourcePdf,
      currency: product.currency || "USD",
      extraction_status: product.extraction_status || "manual",
      image_missing: hasImage ? false : product.image_missing === true,
      is_visible: product.is_visible !== false,
      manual_storage: true,
      local_only: false
    });
  }

  function manualProductId(product) {
    return [
      "manual-storage",
      product.source_pdf || catalog.sourcePdf,
      Number(product.page || 0),
      Number(product.card_index || 0)
    ].join(":");
  }

  function manualProductsStorageUrl() {
    const bucket = config.imageBucket || "product-images";
    return `${baseUrl()}/storage/v1/object/public/${encodeURIComponent(bucket)}/${pathEncode(manualProductsStoragePath())}`;
  }

  function manualProductsStoragePath() {
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    return `${prefix}/manual-products/${safeSourceStem(catalog.sourcePdf)}.json`;
  }

  async function saveOverride(payload, product = state.editing) {
    if (!Object.keys(payload).length) {
      return { skipped: true };
    }

    const table = encodeURIComponent(config.overrideTable || "milana_product_overrides");
    const body = Object.assign({}, payload, {
      source_pdf: product.source_pdf,
      page: product.page,
      card_index: product.card_index
    });
    const response = await supabaseFetch(
      `/rest/v1/${table}?on_conflict=source_pdf,page,card_index`,
      {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const details = await readResponseMessage(response);
      if (hasOwn(payload, "is_visible") && isMissingColumnError(details, "is_visible")) {
        const fallbackPayload = Object.assign({}, payload);
        delete fallbackPayload.is_visible;
        return saveOverride(fallbackPayload, product);
      }

      if (hasOwn(payload, "material_type") && isMissingColumnError(details, "material_type")) {
        const fallbackPayload = Object.assign({}, payload);
        delete fallbackPayload.material_type;
        return saveOverride(fallbackPayload, product);
      }

      throw new Error(details || "Manual override could not be saved.");
    }

    return { saved: true };
  }

  async function createProduct(payload) {
    const table = encodeURIComponent(config.table || "milana_products");
    const position = {
      page: Number(state.editing.page || 0) || nextProductPosition().page,
      card_index: Number(state.editing.card_index || 0) || nextProductPosition().cardIndex
    };
    const row = Object.assign({}, payload, {
      source_system: "milana_manual_admin",
      run_id: "manual-" + new Date().toISOString(),
      catalog_date: new Date().toISOString().slice(0, 10),
      source_pdf: catalog.sourcePdf,
      source_pdf_path: null,
      page: position.page,
      card_index: position.card_index,
      bbox: null,
      extraction_status: payload.is_visible === false ? LEGACY_HIDDEN_STATUS : "manual",
      native_text: null,
      ocr_text: null,
      combined_text: null,
      image_sha256: null,
      image_fingerprint: null,
      embedding_model: null,
      embedding_path: null,
      embedding_preview: null
    });
    const select = productSelectColumns(true, true);
    const response = await supabaseFetch(
      `/rest/v1/${table}?select=${select}`,
      {
        method: "POST",
        headers: {
          Prefer: "return=representation",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(row)
      }
    );

    if (!response.ok) {
      const details = await readResponseMessage(response);
      if (hasOwn(row, "is_visible") && isMissingColumnError(details, "is_visible")) {
        const fallbackRow = Object.assign({}, row);
        delete fallbackRow.is_visible;
        return createProductFromRow(fallbackRow);
      }
      if (hasOwn(row, "material_type") && isMissingColumnError(details, "material_type")) {
        const fallbackRow = Object.assign({}, row);
        delete fallbackRow.material_type;
        return createProductFromRow(fallbackRow);
      }
      if (isRowLevelSecurityError(details)) {
        return saveManualProductToStorage(row);
      }

      throw new Error(details || "New model could not be added. Run the updated Supabase SQL if this is the first time using this feature.");
    }

    const rows = await response.json();
    return Object.assign({}, rows[0], { local_only: false });
  }

  async function createProductFromRow(row) {
    const table = encodeURIComponent(config.table || "milana_products");
    const select = productSelectColumns(hasOwn(row, "is_visible"), hasOwn(row, "material_type"));
    const response = await supabaseFetch(
      `/rest/v1/${table}?select=${select}`,
      {
        method: "POST",
        headers: {
          Prefer: "return=representation",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(row)
      }
    );

    if (!response.ok) {
      const details = await readResponseMessage(response);
      if (hasOwn(row, "is_visible") && isMissingColumnError(details, "is_visible")) {
        const fallbackRow = Object.assign({}, row);
        delete fallbackRow.is_visible;
        return createProductFromRow(fallbackRow);
      }
      if (hasOwn(row, "material_type") && isMissingColumnError(details, "material_type")) {
        const fallbackRow = Object.assign({}, row);
        delete fallbackRow.material_type;
        return createProductFromRow(fallbackRow);
      }
      if (isRowLevelSecurityError(details)) {
        return saveManualProductToStorage(row);
      }

      throw new Error(details || "New model could not be added.");
    }

    const rows = await response.json();
    return Object.assign({}, rows[0], { is_visible: row.extraction_status !== LEGACY_HIDDEN_STATUS, local_only: false });
  }

  async function patchProduct(payload, product = state.editing, includeVisibilityColumn = true, includeMaterialColumn = true) {
    const table = encodeURIComponent(config.table || "milana_products");
    const select = productSelectColumns(includeVisibilityColumn, includeMaterialColumn);
    const response = await supabaseFetch(
      `/rest/v1/${table}?id=eq.${encodeURIComponent(product.id)}&select=${select}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const details = await readResponseMessage(response);
      if (includeVisibilityColumn && isMissingColumnError(details, "is_visible")) {
        const fallbackPayload = hasOwn(payload, "is_visible") ? legacyVisibilityPayload(payload, product) : payload;
        return patchProduct(fallbackPayload, product, false, includeMaterialColumn);
      }
      if (includeMaterialColumn && isMissingColumnError(details, "material_type")) {
        const fallbackPayload = Object.assign({}, payload);
        delete fallbackPayload.material_type;
        return patchProduct(fallbackPayload, product, includeVisibilityColumn, false);
      }

      throw new Error(details || "Product row could not be updated.");
    }

    const rows = await response.json();
    return rows[0];
  }

  async function toggleVisibility(id) {
    const product = state.products.find((item) => String(item.id) === String(id));
    if (!product) {
      return;
    }

    const nextVisible = !isVisible(product);
    const payload = { is_visible: nextVisible };
    Object.assign(product, { saving_visibility: true });
    renderProducts();

    try {
      if (product.manual_storage) {
        const updated = await updateManualProduct(product, payload);
        Object.assign(product, updated || payload, { saving_visibility: false });
      } else if (!product.local_only) {
        const updated = await patchProduct(payload, product);
        Object.assign(product, updated || payload, { saving_visibility: false });
      } else {
        Object.assign(product, payload, { saving_visibility: false });
      }

      if (!product.manual_storage && product.source_system !== "milana_manual_admin") {
        await saveOverride(payload, product);
      }

      applySearch();
    } catch (error) {
      showStatus(error.message || "Visibility could not be changed.");
      Object.assign(product, { saving_visibility: false });
      renderProducts();
    }
  }

  function productSelectColumns(includeVisibilityColumn = true, includeMaterialColumn = true) {
    const columns = [
      "id",
      "source_system",
      "run_id",
      "source_pdf",
      "page",
      "card_index",
      "model_code",
      "product_code",
      "price",
      "currency",
      "image_url",
      "image_storage_bucket",
      "image_storage_path",
      "extraction_status"
    ];
    if (includeVisibilityColumn) {
      columns.push("is_visible");
    }
    if (includeMaterialColumn) {
      columns.splice(8, 0, "material_type");
    }

    return columns.join(",");
  }

  function legacyVisibilityPayload(payload, product) {
    const fallback = Object.assign({}, payload);
    const nextVisible = fallback.is_visible !== false;
    delete fallback.is_visible;
    fallback.extraction_status = nextVisible ? visibleExtractionStatus(product) : LEGACY_HIDDEN_STATUS;
    return fallback;
  }

  function visibleExtractionStatus(product) {
    if (product.source_system === "milana_manual_admin") {
      return "manual";
    }

    if (product.extraction_status && product.extraction_status !== LEGACY_HIDDEN_STATUS) {
      return product.extraction_status;
    }

    return "ok";
  }

  function applySearch() {
    const query = searchEl.value.trim().toLowerCase();
    state.filtered = query
      ? state.products.filter((item) => searchableText(item).includes(query))
      : state.products.slice();
    renderProducts();
  }

  function showWorkspace() {
    loginPanel.hidden = true;
    workspace.hidden = false;
    logoutButton.hidden = false;
  }

  function logout() {
    state.session = null;
    localStorage.removeItem("milana_admin_session");
    loginPanel.hidden = false;
    workspace.hidden = true;
    logoutButton.hidden = true;
  }

  function requireSupabaseConfig() {
    if (!config.supabaseUrl || !config.supabasePublishableKey) {
      throw new Error("Fill site-config.js with Supabase URL and publishable key first.");
    }
  }

  async function supabaseFetch(path, options) {
    requireSupabaseConfig();
    const response = await fetchWithCurrentSession(path, options);
    if (response.status !== 401 || !state.session || !state.session.refresh_token) {
      return response;
    }

    const refreshed = await refreshSession();
    return refreshed ? fetchWithCurrentSession(path, options) : response;
  }

  function fetchWithCurrentSession(path, options) {
    const headers = Object.assign(
      {
        apikey: config.supabasePublishableKey,
        Authorization: `Bearer ${state.session ? state.session.access_token : config.supabasePublishableKey}`
      },
      (options && options.headers) || {}
    );
    return fetch(`${baseUrl()}${path}`, Object.assign({}, options, { headers }));
  }

  async function refreshSession() {
    const response = await fetch(`${baseUrl()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: config.supabasePublishableKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ refresh_token: state.session.refresh_token })
    });

    if (!response.ok) {
      return false;
    }

    state.session = await response.json();
    saveSession(state.session);
    return true;
  }

  function baseUrl() {
    return String(config.supabaseUrl || "").replace(/\/+$/, "");
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem("milana_admin_session") || "null");
    } catch (_error) {
      return null;
    }
  }

  function saveSession(session) {
    localStorage.setItem("milana_admin_session", JSON.stringify(session));
  }

  function pathEncode(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function cleanValue(value) {
    return String(value || "").trim();
  }

  function parsePriceInput(value) {
    const clean = cleanValue(value);
    const normalized = clean.replace(",", ".");
    if (/^\d+(?:\.\d+)?$/.test(normalized)) {
      return {
        value: Number(normalized),
        isNumeric: true
      };
    }

    return {
      value: clean,
      isNumeric: false
    };
  }

  function databaseProductPayload(payload) {
    const cleanPayload = Object.assign({}, payload);
    delete cleanPayload.image_missing;
    return cleanPayload;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isMissingColumnError(message, column) {
    const text = String(message || "").toLowerCase();
    return text.includes(column.toLowerCase()) && (
      text.includes("schema cache") ||
      text.includes("does not exist") ||
      text.includes("could not find")
    );
  }

  function isRowLevelSecurityError(message) {
    return String(message || "").toLowerCase().includes("row-level security");
  }

  function formatPrice(value, currency) {
    const number = Number(value);
    const clean = Number.isFinite(number) ? number.toFixed(2).replace(/\.00$/, "").replace(/0$/, "") : String(value || "");
    if (!clean) {
      return "";
    }
    return currency === "USD" || !currency ? "$" + clean : clean + " " + currency;
  }

  function resolveImageUrl(product) {
    if (!hasProductImage(product)) {
      return "";
    }

    if (product.image_url) {
      return product.image_url;
    }

    const rawPath = product.image_path || "";
    const normalized = String(rawPath).replace(/\\/g, "/");
    const marker = "/outputs/catalog_processing/";
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
      return "outputs/catalog_processing/" + normalized.slice(markerIndex + marker.length);
    }

    if (normalized.startsWith("outputs/")) {
      return normalized;
    }

    return "covers/milana-products-in-stock-en.png";
  }

  function safeSourceStem(value) {
    const name = String(value || "").split(/[\\/]/).pop().replace(/\.pdf$/i, "");
    return name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "catalog";
  }

  function searchableText(item) {
    return [
      item.model_code,
      item.product_code,
      materialType(item),
      item.price,
      item.currency,
      item.source_pdf,
      isVisible(item) ? "visible" : "hidden"
    ].join(" ").toLowerCase();
  }

  function hasProductImage(product) {
    if (product.image_missing === true) {
      return false;
    }

    return Boolean(product.image_url || product.image_path || product.image_storage_path);
  }

  function materialType(product) {
    const value = String(product.material_type || "").trim();
    const inferred = inferMaterialType(product);
    if (value && value !== "Suprem") {
      return value;
    }

    return inferred || value || "Suprem";
  }

  function inferMaterialType(product) {
    const text = [
      product.combined_text,
      product.ocr_text,
      product.native_text
    ].join(" ").toUpperCase().replace(/[^A-ZА-ЯЁ0-9%]+/g, " ");

    if (hasMaterialAlias(text, ["LAPSHA", "ЛАПША", "NANWA", "ЛANWA"])) {
      return "Lapsha";
    }
    if (hasMaterialAlias(text, ["INTERLOCK SUPREM", "INTERLOCK SUPREME", "ИНТЕРЛОК СУПРЕМ", "WHTEPNOK CYNPEM"])) {
      return "Interlock Suprem";
    }
    if (hasMaterialAlias(text, ["MUSLIN", "МУСЛИН", "MYCNUH", "MYCNNH", "MYCNUN"])) {
      return "Muslin";
    }
    if (hasMaterialAlias(text, ["WAFFLE", "WAFLE", "WAFFEL"])) {
      return "Waffle";
    }
    if (hasMaterialAlias(text, ["INTERLOCK", "ИНТЕРЛОК", "WHTEPNOK", "NTERLOCK"])) {
      return "Interlock";
    }
    if (hasMaterialAlias(text, ["BAMBUK", "BAMBOO", "БАМБУК"])) {
      return "Bambuk";
    }
    if (hasMaterialAlias(text, ["VISCOSE", "VISCOSA", "ВИСКОЗ"])) {
      return "Viscose";
    }
    if (hasMaterialAlias(text, ["POLYESTER", "POLIESTER", "ПОЛИЭСТЕР"])) {
      return "Polyester";
    }
    if (hasMaterialAlias(text, ["RIBANA", "RIBAN", "РИБАН"])) {
      return "Ribana";
    }
    if (hasMaterialAlias(text, ["FLEECE", "FLIS", "FLISLI", "ФЛИС"])) {
      return "Fleece";
    }
    if (hasMaterialAlias(text, ["VELOUR", "VELUR", "ВЕЛЮР"])) {
      return "Velour";
    }
    if (hasMaterialAlias(text, ["SUPREM", "SUPREME", "СУПРЕМ", "CYNPEM"])) {
      return "Suprem";
    }
    return "";
  }

  function hasMaterialAlias(text, aliases) {
    return aliases.some((alias) => text.includes(alias));
  }

  function showStatus(message) {
    statusEl.hidden = false;
    statusEl.textContent = message;
  }

  function hideStatus() {
    statusEl.hidden = true;
    statusEl.textContent = "";
  }

  function showError(error) {
    showStatus(error.message || "Something went wrong.");
  }

  async function readResponseMessage(response) {
    try {
      const data = await response.json();
      return [data.error_code, data.msg, data.message, data.error_description, data.error]
        .filter(Boolean)
        .join(": ");
    } catch (_error) {
      return response.statusText || "";
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }
})();
