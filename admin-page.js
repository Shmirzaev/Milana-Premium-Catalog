(function () {
  const CATALOGS = [
    { id: 1, sourcePdf: "01_Staple_Model_Catalog.pdf", title: "Staple Model Catalog" },
    { id: 2, sourcePdf: "02_Milana_Man_Premium_Collection.pdf", title: "Milana Man Premium Collection" },
    { id: 3, sourcePdf: "03_Kindergarten_Set.pdf", title: "Kindergarten Set" },
    { id: 4, sourcePdf: "04_Milana_Products_in_Stock.pdf", title: "Milana Products in Stock" }
  ];

  const config = window.MILANA_CONFIG || {};
  const LEGACY_HIDDEN_STATUS = "admin_hidden";
  const LOCAL_IMAGE_VERSION = "20260608-q76";
  const MANUAL_UPLOAD_MAX_WIDTH = 900;
  const MANUAL_UPLOAD_MAX_HEIGHT = 1250;
  const MANUAL_UPLOAD_JPEG_QUALITY = 0.76;
  const params = new URLSearchParams(window.location.search);
  const catalogId = Number(params.get("id")) || 1;
  const catalog = CATALOGS.find((item) => item.id === catalogId) || CATALOGS[0];
  const state = {
    session: readSession(),
    products: [],
    filtered: [],
    editing: null,
    creating: false,
    productOrder: [],
    visibilityOverrides: new Map(),
    draggingProductKey: "",
    catalogSettings: { show_prices: true },
    savingCatalogSettings: false
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
  const toggleClientPricesButton = document.getElementById("toggleClientPrices");

  titleEl.textContent = catalog.title;
  numberEl.textContent = "Catalog 0" + catalog.id;
  document.querySelectorAll("[data-catalog-link]").forEach((link) => {
    link.classList.toggle("active", Number(link.dataset.catalogLink) === catalog.id);
  });

  loginForm.addEventListener("submit", handleLogin);
  logoutButton.addEventListener("click", logout);
  addProductButton.addEventListener("click", openCreator);
  if (toggleClientPricesButton) {
    toggleClientPricesButton.addEventListener("click", toggleClientPriceVisibility);
  }
  searchEl.addEventListener("input", applySearch);
  gridEl.addEventListener("error", handleGridImageError, true);
  gridEl.addEventListener("dragstart", handleDragStart);
  gridEl.addEventListener("dragover", handleDragOver);
  gridEl.addEventListener("dragleave", handleDragLeave);
  gridEl.addEventListener("drop", handleDrop);
  gridEl.addEventListener("dragend", handleDragEnd);
  gridEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-drag-handle]")) {
      return;
    }

    const moveButton = event.target.closest("[data-move-action]");
    if (moveButton) {
      moveProduct(moveButton.dataset.productKey, moveButton.dataset.moveAction);
      return;
    }

    const visibilityButton = event.target.closest("[data-visibility-key]");
    if (visibilityButton) {
      toggleVisibility(visibilityButton.dataset.visibilityKey);
      return;
    }

    const button = event.target.closest("[data-edit-key]");
    if (!button) {
      return;
    }
    openEditor(button.dataset.editKey);
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
    const [localResult, supabaseResult, manualResult, orderResult, visibilityResult, settingsResult] = await Promise.allSettled([
      readProductsFromLocalJson(),
      readProductsFromSupabase(),
      readManualProductsFromStorage(),
      readProductOrderFromStorage(),
      readProductVisibilityFromStorage(),
      readCatalogSettingsFromStorage()
    ]);
    const localProducts = localResult.status === "fulfilled" ? localResult.value : [];
    const supabaseProducts = supabaseResult.status === "fulfilled" ? supabaseResult.value : [];
    const manualProducts = manualResult.status === "fulfilled" ? manualResult.value : [];
    state.productOrder = orderResult.status === "fulfilled" ? orderResult.value : [];
    state.visibilityOverrides = new Map(
      Object.entries(visibilityResult.status === "fulfilled" ? visibilityResult.value : {})
        .map(([key, value]) => [key, value !== false])
    );
    state.catalogSettings = normalizeCatalogSettings(settingsResult.status === "fulfilled" ? settingsResult.value : {});
    syncClientPriceToggle();
    if (!localProducts.length && !supabaseProducts.length) {
      const error = supabaseResult.status === "rejected" ? supabaseResult.reason : localResult.reason;
      throw new Error((error && error.message) || "Main catalog products could not be loaded.");
    }

    const mergedKeys = new Set();

    state.products = (localProducts.length ? localProducts : supabaseProducts).map((product) => {
      const key = productKey(product);
      mergedKeys.add(key);
      return normalizeProductImageState(Object.assign({}, product, {
        local_only: Boolean(localProducts.length)
      }));
    });
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
    state.products = state.products.map(applyVisibilityOverride);
    state.products.sort(compareProducts);
    state.filtered = state.products.slice();
    if (localProducts.length) {
      showStatus("Loaded from locked final catalog data.");
    } else {
      hideStatus();
    }
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
    const order = new Map(state.productOrder.map((key, index) => [key, index]));
    const aIndex = order.has(productKey(a)) ? order.get(productKey(a)) : Number.POSITIVE_INFINITY;
    const bIndex = order.has(productKey(b)) ? order.get(productKey(b)) : Number.POSITIVE_INFINITY;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }

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
      const imageFallbacks = image ? adminImageFallbacks(product, image) : [];
      const price = escapeHtml(formatPrice(product.price, product.currency));
      const visible = isVisible(product);
      const key = escapeAttribute(productKey(product));
      return `
        <article class="product-card${visible ? "" : " is-off"}" draggable="true" data-product-key="${key}">
          ${visible ? "" : '<span class="visibility-badge">Off</span>'}
          <button class="drag-handle" type="button" data-drag-handle title="Drag to reorder" aria-label="Drag to reorder">::</button>
          <div class="move-controls" aria-label="Move card">
            <button type="button" data-move-action="top" data-product-key="${key}" title="Move to top" aria-label="Move to top">&#8679;</button>
            <button type="button" data-move-action="up" data-product-key="${key}" title="Move up" aria-label="Move up">&#8593;</button>
            <button type="button" data-move-action="down" data-product-key="${key}" title="Move down" aria-label="Move down">&#8595;</button>
          </div>
          <button class="edit-button" type="button" data-edit-key="${key}">Edit</button>
          <button
            class="visibility-switch ${visible ? "is-on" : "is-off"}${product.saving_visibility ? " is-saving" : ""}"
            type="button"
            data-visibility-key="${key}"
            aria-label="${visible ? "Turn client visibility off" : "Turn client visibility on"}"
            aria-pressed="${visible ? "true" : "false"}"
            ${product.saving_visibility ? "disabled" : ""}>
            <span class="switch-label">${product.saving_visibility ? "..." : visible ? "ON" : "OFF"}</span>
            <span class="switch-knob" aria-hidden="true"></span>
          </button>
          <div class="product-image">
            ${image ? `<img src="${escapeAttribute(image)}" alt="${model}" loading="lazy" data-fallback-srcs="${escapeAttribute(JSON.stringify(imageFallbacks))}">` : '<div class="missing-image">No image</div>'}
          </div>
          <div class="product-info">
            <div class="model-row">
              <h2 class="model">${model}</h2>
              <p class="price">${price}</p>
            </div>
            <p class="code">Code ${code}</p>
            <div class="card-move-actions" aria-label="Move card">
              <button type="button" data-move-action="top" data-product-key="${key}">Top</button>
              <button type="button" data-move-action="left" data-product-key="${key}">Left</button>
              <button type="button" data-move-action="right" data-product-key="${key}">Right</button>
            </div>
          </div>
        </article>
      `;
  }

  function openEditor(key) {
    const product = state.products.find((item) => productKey(item) === String(key));
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
        const manualOverlay = hasEditedImage && !state.editing.manual_storage
          ? await saveManualProductToStorage(imageEditStoragePayload(state.editing, payload))
          : null;
        const updated = !priceInput.isNumeric
          ? await updateManualProduct(state.editing, payload)
          : state.editing.manual_storage
          ? await updateManualProduct(state.editing, payload)
          : state.editing.local_only
            ? payload
            : await patchProduct(databasePayload).catch((error) => {
              if (manualOverlay) {
                console.warn(error);
                return null;
              }

              throw error;
            });
        if (priceInput.isNumeric && !state.editing.manual_storage && state.editing.source_system !== "milana_manual_admin") {
          await saveOverride(databasePayload).catch((error) => console.warn(error));
        }
        Object.assign(state.editing, updated || payload, manualOverlay || {});
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
    const uploadFile = await optimizeImageUpload(file).catch((error) => {
      console.warn(error);
      return file;
    });
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "product.jpg";
    const objectName = uploadFile === file ? safeName : safeName.replace(/\.[^.]+$/, "") + ".jpg";
    const objectPath = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${objectName}`;
    const response = await supabaseFetch(
      `/storage/v1/object/${encodeURIComponent(bucket)}/${pathEncode(objectPath)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": uploadFile.type || "application/octet-stream",
          "x-upsert": "true"
        },
        body: uploadFile
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

  async function optimizeImageUpload(file) {
    if (!file || !String(file.type || "").startsWith("image/") || file.type === "image/svg+xml") {
      return file;
    }

    const bitmap = await createImageBitmap(file);
    const scale = Math.min(
      1,
      MANUAL_UPLOAD_MAX_WIDTH / bitmap.width,
      MANUAL_UPLOAD_MAX_HEIGHT / bitmap.height
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      bitmap.close();
      return file;
    }

    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => {
        value ? resolve(value) : reject(new Error("Picture could not be optimized."));
      }, "image/jpeg", MANUAL_UPLOAD_JPEG_QUALITY);
    });

    if (!blob || blob.size >= file.size) {
      return file;
    }

    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
      lastModified: Date.now()
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Picture upload failed."));
      reader.readAsDataURL(file);
    });
  }

  function imageEditStoragePayload(product, payload) {
    return Object.assign({}, product, payload, {
      extraction_status: payload.is_visible === false ? LEGACY_HIDDEN_STATUS : visibleExtractionStatus(product),
      manual_storage: true,
      local_only: false
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

  async function readProductOrderFromStorage() {
    return readCatalogListFromStorage(productOrderStorageUrl(), "order");
  }

  async function writeProductOrderToStorage() {
    state.productOrder = state.products.map(productKey);
    return writeCatalogListToStorage(productOrderStoragePath(), {
      source_pdf: catalog.sourcePdf,
      updated_at: new Date().toISOString(),
      order: state.productOrder
    });
  }

  async function readCatalogListFromStorage(url, field) {
    if (!config.supabaseUrl) {
      return [];
    }

    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404 || !response.ok) {
      return [];
    }

    const payload = await response.json();
    const values = Array.isArray(payload) ? payload : payload && payload[field];
    return Array.isArray(values) ? values.filter(Boolean).map(String) : [];
  }

  async function writeCatalogListToStorage(path, payload) {
    const bucket = config.imageBucket || "product-images";
    const response = await supabaseFetch(
      `/storage/v1/object/${encodeURIComponent(bucket)}/${pathEncode(path)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-upsert": "true"
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const details = await readResponseMessage(response);
      throw new Error(details || "Catalog settings could not be saved.");
    }
  }

  function productOrderStorageUrl() {
    const bucket = config.imageBucket || "product-images";
    return `${baseUrl()}/storage/v1/object/public/${encodeURIComponent(bucket)}/${pathEncode(productOrderStoragePath())}`;
  }

  function productOrderStoragePath() {
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    return `${prefix}/product-order/${safeSourceStem(catalog.sourcePdf)}.json`;
  }

  async function readProductVisibilityFromStorage() {
    const localPayload = readLocalVisibilityOverrides();
    const localVisibility = localPayload.pending_remote_write
      ? visibilityObject(localPayload.visibility || {})
      : hiddenVisibilityOnly(localPayload.visibility || {});
    if (!config.supabaseUrl) {
      return localVisibility;
    }

    const response = await fetch(productVisibilityStorageUrl(), { cache: "no-store" });
    if (response.status === 404 || !response.ok) {
      return localVisibility;
    }

    const payload = await response.json();
    const remoteVisibility = hiddenVisibilityOnly(payload && payload.visibility);
    if (localPayload.pending_remote_write || isNewerVisibilityPayload(localPayload, payload)) {
      return Object.assign({}, remoteVisibility, localVisibility);
    }

    return Object.assign({}, localVisibility, remoteVisibility);
  }

  async function writeProductVisibilityToStorage() {
    const visibility = Object.fromEntries(state.visibilityOverrides);
    const payload = {
      source_pdf: catalog.sourcePdf,
      updated_at: new Date().toISOString(),
      visibility: hiddenVisibilityOnly(visibility)
    };
    writeLocalVisibilityOverrides(true, Object.assign({}, payload, { visibility }));
    await writeCatalogListToStorage(productVisibilityStoragePath(), payload);
    writeLocalVisibilityOverrides(false, payload);
  }

  function productVisibilityStorageUrl() {
    const bucket = config.imageBucket || "product-images";
    const cacheBust = "v=" + encodeURIComponent(String(Date.now()));
    return `${baseUrl()}/storage/v1/object/public/${encodeURIComponent(bucket)}/${pathEncode(productVisibilityStoragePath())}?${cacheBust}`;
  }

  function productVisibilityStoragePath() {
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    return `${prefix}/product-visibility/${safeSourceStem(catalog.sourcePdf)}.json`;
  }

  async function readCatalogSettingsFromStorage() {
    const localPayload = readLocalCatalogSettings();
    if (!config.supabaseUrl) {
      return normalizeCatalogSettings(localPayload);
    }

    const response = await fetch(catalogSettingsStorageUrl(), { cache: "no-store" });
    if (response.status === 404 || !response.ok) {
      return normalizeCatalogSettings(localPayload);
    }

    const payload = await response.json();
    if (localPayload.pending_remote_write || isNewerCatalogSettingsPayload(localPayload, payload)) {
      return normalizeCatalogSettings(Object.assign({}, payload, localPayload));
    }

    return normalizeCatalogSettings(Object.assign({}, localPayload, payload));
  }

  async function writeCatalogSettingsToStorage() {
    const payload = {
      source_pdf: catalog.sourcePdf,
      updated_at: new Date().toISOString(),
      show_prices: state.catalogSettings.show_prices !== false
    };
    writeLocalCatalogSettings(true, payload);
    if (!config.supabaseUrl) {
      writeLocalCatalogSettings(false, payload);
      return;
    }

    await writeCatalogListToStorage(catalogSettingsStoragePath(), payload);
    writeLocalCatalogSettings(false, payload);
  }

  function catalogSettingsStorageUrl() {
    const bucket = config.imageBucket || "product-images";
    const cacheBust = "v=" + encodeURIComponent(String(Date.now()));
    return `${baseUrl()}/storage/v1/object/public/${encodeURIComponent(bucket)}/${pathEncode(catalogSettingsStoragePath())}?${cacheBust}`;
  }

  function catalogSettingsStoragePath() {
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    return `${prefix}/catalog-settings/${safeSourceStem(catalog.sourcePdf)}.json`;
  }

  function readLocalCatalogSettings() {
    try {
      const payload = JSON.parse(localStorage.getItem(localCatalogSettingsStorageKey()) || "{}");
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    } catch (_error) {
      return {};
    }
  }

  function writeLocalCatalogSettings(pendingRemoteWrite, payload) {
    localStorage.setItem(localCatalogSettingsStorageKey(), JSON.stringify(Object.assign({}, payload, {
      pending_remote_write: pendingRemoteWrite === true
    })));
  }

  function localCatalogSettingsStorageKey() {
    return `milana_catalog_settings_${safeSourceStem(catalog.sourcePdf)}`;
  }

  function isNewerCatalogSettingsPayload(candidate, reference) {
    const candidateTime = Date.parse(candidate && candidate.updated_at || "");
    const referenceTime = Date.parse(reference && reference.updated_at || "");
    return Number.isFinite(candidateTime) && Number.isFinite(referenceTime) && candidateTime >= referenceTime;
  }

  function normalizeCatalogSettings(settings) {
    return {
      show_prices: !(settings && settings.show_prices === false)
    };
  }

  async function toggleClientPriceVisibility() {
    if (state.savingCatalogSettings) {
      return;
    }

    const previousShowPrices = state.catalogSettings.show_prices !== false;
    state.catalogSettings = { show_prices: !previousShowPrices };
    state.savingCatalogSettings = true;
    syncClientPriceToggle();

    try {
      await writeCatalogSettingsToStorage();
      showStatus(state.catalogSettings.show_prices ? "Client catalog prices are now visible." : "Client catalog prices are now hidden.");
    } catch (error) {
      console.warn(error);
      state.catalogSettings = { show_prices: previousShowPrices };
      showStatus(error.message || "Client price setting could not be saved.");
    } finally {
      state.savingCatalogSettings = false;
      syncClientPriceToggle();
    }
  }

  function syncClientPriceToggle() {
    if (!toggleClientPricesButton) {
      return;
    }

    const showPrices = state.catalogSettings.show_prices !== false;
    toggleClientPricesButton.disabled = state.savingCatalogSettings;
    toggleClientPricesButton.setAttribute("aria-pressed", String(!showPrices));
    toggleClientPricesButton.textContent = state.savingCatalogSettings
      ? "Saving..."
      : showPrices
        ? "Hide client prices"
        : "Show client prices";
  }

  function readLocalVisibilityOverrides() {
    try {
      const payload = JSON.parse(localStorage.getItem(localVisibilityStorageKey()) || "{}");
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    } catch (_error) {
      return {};
    }
  }

  function writeLocalVisibilityOverrides(pendingRemoteWrite, payload) {
    localStorage.setItem(localVisibilityStorageKey(), JSON.stringify(Object.assign({}, payload, {
      pending_remote_write: pendingRemoteWrite === true
    })));
  }

  function localVisibilityStorageKey() {
    return `milana_visibility_${safeSourceStem(catalog.sourcePdf)}`;
  }

  function isNewerVisibilityPayload(candidate, reference) {
    const candidateTime = Date.parse(candidate && candidate.updated_at || "");
    const referenceTime = Date.parse(reference && reference.updated_at || "");
    return Number.isFinite(candidateTime) && Number.isFinite(referenceTime) && candidateTime >= referenceTime;
  }

  function hiddenVisibilityOnly(visibility) {
    const values = visibilityObject(visibility);
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value === false));
  }

  function visibilityObject(visibility) {
    return visibility && typeof visibility === "object" && !Array.isArray(visibility)
      ? visibility
      : {};
  }

  function applyVisibilityOverride(product) {
    const key = productKey(product);
    if (!state.visibilityOverrides.has(key)) {
      return product;
    }

    const visible = state.visibilityOverrides.get(key) !== false;
    return Object.assign({}, product, {
      is_visible: visible,
      extraction_status: visible ? visibleExtractionStatus(product) : LEGACY_HIDDEN_STATUS
    });
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

  async function toggleVisibility(key) {
    const product = state.products.find((item) => productKey(item) === String(key));
    if (!product || product.saving_visibility) {
      return;
    }

    const nextVisible = !isVisible(product);
    const payload = { is_visible: nextVisible };
    state.visibilityOverrides.set(key, nextVisible);
    Object.assign(product, {
      is_visible: nextVisible,
      extraction_status: nextVisible ? visibleExtractionStatus(product) : LEGACY_HIDDEN_STATUS,
      saving_visibility: false
    });
    applySearch();
    persistVisibilityChange(product, key, payload, nextVisible).catch((error) => {
      console.warn(error);
      showStatus(error.message || "Visibility is changed on screen, but the saved state could not be updated.");
    });
  }

  async function persistVisibilityChange(product, key, payload, nextVisible) {
    await writeProductVisibilityToStorage();

    if (product.manual_storage) {
      const updated = await updateManualProduct(product, legacyVisibilityPayload(payload, product));
      Object.assign(product, updated || payload, { saving_visibility: false });
    } else {
      const manualOverlay = await saveManualProductToStorage(visibilityStoragePayload(product, nextVisible));
      Object.assign(product, manualOverlay, { saving_visibility: false });
      if (!product.local_only) {
        try {
          const updated = await patchProduct(payload, product);
          Object.assign(product, updated || {}, manualOverlay, { saving_visibility: false });
        } catch (error) {
          console.warn(error);
        }
      }
    }

    if (!product.manual_storage && product.source_system !== "milana_manual_admin") {
      try {
        await saveOverride(payload, product);
      } catch (error) {
        console.warn(error);
      }
    }

    Object.assign(product, applyVisibilityOverride(product), { saving_visibility: false });
    applySearch();
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

  function visibilityStoragePayload(product, nextVisible) {
    return Object.assign({}, product, {
      is_visible: nextVisible,
      extraction_status: nextVisible ? visibleExtractionStatus(product) : LEGACY_HIDDEN_STATUS,
      manual_storage: true,
      local_only: false
    });
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

  function handleDragStart(event) {
    const card = event.target instanceof Element ? event.target.closest("[data-product-key]") : null;
    if (!card) {
      return;
    }

    if (searchEl.value.trim()) {
      event.preventDefault();
      showStatus("Clear search before moving cards.");
      return;
    }

    state.draggingProductKey = card.dataset.productKey || "";
    card.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.draggingProductKey);
    }
  }

  function handleDragOver(event) {
    if (!state.draggingProductKey) {
      return;
    }

    const card = event.target instanceof Element ? event.target.closest("[data-product-key]") : null;
    if (!card || card.dataset.productKey === state.draggingProductKey) {
      return;
    }

    event.preventDefault();
    card.classList.add("is-drop-target");
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  function handleDragLeave(event) {
    const card = event.target instanceof Element ? event.target.closest("[data-product-key]") : null;
    if (card) {
      card.classList.remove("is-drop-target");
    }
  }

  async function handleDrop(event) {
    const card = event.target instanceof Element ? event.target.closest("[data-product-key]") : null;
    if (!card || !state.draggingProductKey) {
      return;
    }

    event.preventDefault();
    clearDragClasses();
    const targetKey = card.dataset.productKey || "";
    if (!targetKey || targetKey === state.draggingProductKey) {
      return;
    }

    moveProductBefore(state.draggingProductKey, targetKey);
    try {
      await saveProductOrder();
      showStatus("Card order saved.");
    } catch (error) {
      showStatus(error.message || "Card order could not be saved.");
    }
  }

  function handleDragEnd() {
    state.draggingProductKey = "";
    clearDragClasses();
  }

  function clearDragClasses() {
    gridEl.querySelectorAll(".is-dragging, .is-drop-target").forEach((card) => {
      card.classList.remove("is-dragging", "is-drop-target");
    });
  }

  function moveProductBefore(sourceKey, targetKey) {
    const sourceIndex = state.products.findIndex((product) => productKey(product) === sourceKey);
    if (sourceIndex < 0) {
      return;
    }

    const moved = state.products.splice(sourceIndex, 1)[0];
    const targetIndex = state.products.findIndex((product) => productKey(product) === targetKey);
    state.products.splice(targetIndex < 0 ? state.products.length : targetIndex, 0, moved);
    state.productOrder = state.products.map(productKey);
    applySearch();
  }

  async function moveProduct(sourceKey, action) {
    if (searchEl.value.trim()) {
      showStatus("Clear search before moving cards.");
      return;
    }

    const sourceIndex = state.products.findIndex((product) => productKey(product) === sourceKey);
    if (sourceIndex < 0) {
      return;
    }

    let targetIndex = sourceIndex;
    if (action === "top") {
      targetIndex = 0;
    } else if (action === "up" || action === "left") {
      targetIndex = Math.max(0, sourceIndex - 1);
    } else if (action === "down" || action === "right") {
      targetIndex = Math.min(state.products.length - 1, sourceIndex + 1);
    }

    if (targetIndex === sourceIndex) {
      return;
    }

    const moved = state.products.splice(sourceIndex, 1)[0];
    state.products.splice(targetIndex, 0, moved);
    state.productOrder = state.products.map(productKey);
    applySearch();

    try {
      await saveProductOrder();
      showStatus("Card order saved.");
    } catch (error) {
      showStatus(error.message || "Card order could not be saved.");
    }
  }

  async function saveProductOrder() {
    state.productOrder = state.products.map(productKey);
    await writeProductOrderToStorage();
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

    const explicitImage = String(product.image_url || "").trim();
    if (explicitImage && (!product.image_path || isManualImageUrl(explicitImage))) {
      return explicitImage;
    }

    const localImage = localProductImageUrl(product) || derivedLocalImageUrl(product);
    if (localImage) {
      return deployedImagePath(localImage);
    }

    if (explicitImage) {
      return explicitImage;
    }

    return "";
  }

  function localProductImageUrl(product) {
    const rawPath = product.image_path || "";
    const normalized = String(rawPath).replace(/\\/g, "/");
    const marker = "/outputs/catalog_processing/";
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
      return versionLocalImageUrl("outputs/catalog_processing/" + normalized.slice(markerIndex + marker.length));
    }

    if (normalized.startsWith("outputs/")) {
      return versionLocalImageUrl(normalized);
    }

    return "";
  }

  function deployedImagePath(value) {
    return String(value || "").replace(
      "outputs/catalog_processing/images/latest/",
      "outputs/catalog_processing/storage_images/latest/"
    );
  }

  function versionLocalImageUrl(value) {
    const url = String(value || "");
    if (!url || url.includes("?") || !url.startsWith("outputs/")) {
      return url;
    }

    return `${url}?v=${LOCAL_IMAGE_VERSION}`;
  }

  function isManualImageUrl(value) {
    return String(value || "").includes("/manual-edits/");
  }

  function manualImageUrl(product) {
    const explicitImage = String((product && product.image_url) || "").trim();
    return isManualImageUrl(explicitImage) ? explicitImage : "";
  }

  function adminImageFallbacks(product, currentImage) {
    return uniqueValues([
      manualImageUrl(product),
      derivedLocalImageUrl(product),
      deployedImagePath(localProductImageUrl(product)),
      deployedImagePath(currentImage),
      product.image_url
    ]).filter((value) => value !== currentImage);
  }

  function derivedLocalImageUrl(product) {
    const stem = safeSourceStem(product.source_pdf);
    const page = padNumber(product.page);
    const card = padNumber(product.card_index);
    if (!stem || !page || !card) {
      return "";
    }

    return versionLocalImageUrl(`outputs/catalog_processing/storage_images/latest/${stem}_p${page}_c${card}.jpg`);
  }

  function padNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return "";
    }

    return String(Math.trunc(number)).padStart(3, "0");
  }

  function handleGridImageError(event) {
    const img = event.target instanceof HTMLImageElement ? event.target : null;
    if (!img) {
      return;
    }

    const fallbacks = readImageFallbacks(img);
    if (!fallbacks.length) {
      showMissingImage(img);
      return;
    }

    const next = fallbacks.shift();
    img.dataset.fallbackSrcs = JSON.stringify(fallbacks);
    if (next && img.src !== next) {
      img.src = next;
    }
  }

  function showMissingImage(img) {
    const wrapper = img.closest(".product-image");
    if (!wrapper) {
      return;
    }

    wrapper.innerHTML = '<div class="missing-image">No image</div>';
  }

  function readImageFallbacks(img) {
    try {
      const values = JSON.parse(img.dataset.fallbackSrcs || "[]");
      return Array.isArray(values) ? values.filter(Boolean) : [];
    } catch (_error) {
      return [];
    }
  }

  function uniqueValues(values) {
    const seen = new Set();
    return values.filter((value) => {
      const clean = String(value || "").trim();
      if (!clean || seen.has(clean)) {
        return false;
      }

      seen.add(clean);
      return true;
    });
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
    const hasImage = Boolean(product && (product.image_url || product.image_path || product.image_storage_path));
    if (product.image_missing === true && !hasImage) {
      return false;
    }

    return hasImage;
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
