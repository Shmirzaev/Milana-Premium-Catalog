(function () {
  const CATALOGS = [
    {
      id: 1,
      sourcePdf: "01_Staple_Model_Catalog.pdf",
      titles: {
        en: "Staple Model Catalog",
        ru: "Каталог моделей из Штапеля",
        uz: "Shtapel modellari katalogi"
      }
    },
    {
      id: 2,
      sourcePdf: "02_Milana_Man_Premium_Collection.pdf",
      titles: {
        en: "Milana Man Premium Collection",
        ru: "Milana Man Premium Collection",
        uz: "Milana Man Premium Collection"
      }
    },
    {
      id: 3,
      sourcePdf: "03_Kindergarten_Set.pdf",
      titles: {
        en: "Kindergarten Set",
        ru: "Комплект для Садика",
        uz: "Bog'cha uchun komplekt"
      }
    },
    {
      id: 4,
      sourcePdf: "04_Milana_Products_in_Stock.pdf",
      titles: {
        en: "Milana Products in Stock",
        ru: "Милана наличие товаров",
        uz: "Milana mavjud mahsulotlar"
      }
    }
  ];

  const params = new URLSearchParams(window.location.search);
  const catalogId = Number(params.get("id")) || 1;
  const catalog = CATALOGS.find((item) => item.id === catalogId) || CATALOGS[0];
  const lang = localStorage.getItem("mp_lang") || document.documentElement.lang || "uz";
  const config = window.MILANA_CONFIG || {};
  const LEGACY_HIDDEN_STATUS = "admin_hidden";
  const CARD_IMAGE_WIDTHS = [320, 520, 720];
  const DEFAULT_CARD_IMAGE_WIDTH = 520;
  const EAGER_IMAGE_COUNT = 12;
  const HIGH_PRIORITY_IMAGE_COUNT = 6;
  const LOCAL_IMAGE_VERSION = "20260608-q76";
  const state = {
    products: [],
    filtered: [],
    productOrder: [],
    visibilityOverrides: new Map()
  };

  const titleEl = document.getElementById("catalogTitle");
  const numberEl = document.getElementById("catalogNumber");
  const gridEl = document.getElementById("productGrid");
  const countEl = document.getElementById("productCount");
  const searchEl = document.getElementById("productSearch");
  const statusEl = document.getElementById("status");
  const productModal = document.getElementById("productModal");
  const productModalCard = document.getElementById("productModalCard");
  const closeProductModal = document.getElementById("closeProductModal");
  const adminShortcut = document.getElementById("adminShortcut");
  const exportPdfButton = document.getElementById("exportPdf");
  const headerExportPdfButton = document.getElementById("headerExportPdf");

  preconnectTo(config.supabaseUrl);

  titleEl.textContent = catalog.titles[lang] || catalog.titles.en;
  numberEl.textContent = "Catalog 0" + catalog.id;
  document.title = titleEl.textContent + " | Milana Premium";
  if (adminShortcut) {
    adminShortcut.href = "admin.html?id=" + catalog.id;
  }
  document.querySelectorAll("[data-catalog-link]").forEach((link) => {
    link.classList.toggle("active", Number(link.dataset.catalogLink) === catalog.id);
  });

  searchEl.addEventListener("input", () => {
    filterProducts();
    renderProducts();
  });
  [exportPdfButton, headerExportPdfButton].filter(Boolean).forEach((button) => {
    button.addEventListener("click", exportCatalogPdf);
  });

  gridEl.addEventListener("click", (event) => {
    const card = event.target instanceof Element ? event.target.closest("[data-product-index]") : null;
    if (!card) {
      return;
    }

    openProductModal(Number(card.dataset.productIndex));
  });

  gridEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const card = event.target instanceof Element ? event.target.closest("[data-product-index]") : null;
    if (!card) {
      return;
    }

    event.preventDefault();
    openProductModal(Number(card.dataset.productIndex));
  });
  gridEl.addEventListener("error", handleGridImageError, true);

  closeProductModal.addEventListener("click", closeProductModalView);
  productModal.addEventListener("click", (event) => {
    if (event.target === productModal) {
      closeProductModalView();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !productModal.hidden) {
      closeProductModalView();
    }
  });

  loadProducts().catch((error) => {
    console.error(error);
    showStatus("Products could not be loaded. Check Supabase config or run the local processor again.");
    countEl.textContent = "0 items";
  });

  async function loadProducts() {
    showStatus("Loading products...");
    const [products, manualProducts, productOrder, visibilityOverrides] = await Promise.all([
      readProducts(),
      readManualProductsFromStorage().catch(() => []),
      readProductOrderFromStorage().catch(() => []),
      readProductVisibilityFromStorage().catch(() => ({}))
    ]);
    state.productOrder = productOrder;
    state.visibilityOverrides = new Map(
      Object.entries(visibilityOverrides).map(([key, value]) => [key, value !== false])
    );
    setProducts(mergeManualProducts(products, manualProducts));

    renderProducts();
  }

  function setProducts(products) {
    state.products = removeCatalog4ImagePlaceholders(products)
      .filter((item) => item && item.source_pdf === catalog.sourcePdf)
      .map(applyVisibilityOverride)
      .filter(isVisible)
      .sort(compareProducts);
    filterProducts();

    if (!state.products.length) {
      showStatus("No products found for this catalog yet.");
    } else {
      hideStatus();
    }
  }

  function filterProducts() {
    const query = searchEl.value.trim().toLowerCase();
    state.filtered = query
      ? state.products.filter((item) => searchableText(item).includes(query))
      : state.products.slice();
  }

  async function readProducts() {
    try {
      return await readFromLocalJson();
    } catch (localError) {
      if (!config.supabaseUrl || !config.supabasePublishableKey) {
        throw localError;
      }

      return await withTimeout(readFromSupabase(), Number(config.supabaseTimeoutMs || 8000));
    }
  }

  function mergeManualProducts(products, manualProducts) {
    const merged = (products || []).map(normalizeProductImageState);
    const keys = new Set(merged.map(productKey));
    (manualProducts || []).forEach((product) => {
      const key = productKey(product);
      const existingIndex = merged.findIndex((item) => productKey(item) === key);
      if (existingIndex >= 0) {
        merged[existingIndex] = normalizeProductImageState(Object.assign({}, merged[existingIndex], product));
      } else {
        keys.add(key);
        merged.push(normalizeProductImageState(product));
      }
    });
    return merged;
  }

  function productKey(product) {
    return [
      product.source_pdf || "",
      Number(product.page || 0),
      Number(product.card_index || 0)
    ].join(":");
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
      return products || [];
    }

    const imageKeys = new Set();
    (products || []).forEach((product) => {
      const key = productDuplicateKey(product);
      if (key && hasProductImage(product)) {
        imageKeys.add(key);
      }
    });

    return (products || []).filter((product) => {
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

  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("Timed out while loading Supabase products."));
      }, timeoutMs);

      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function productsSignature(products) {
    return (products || [])
      .map((item) => [
        item.source_pdf,
        item.page,
        item.card_index,
        item.product_code,
        item.model_code,
        materialType(item),
        item.price,
        item.image_url,
        item.image_storage_path,
        item.image_missing,
        item.extraction_status,
        item.is_visible
      ].join(":"))
      .join("|");
  }

  async function readFromSupabase() {
    if (!config.supabaseUrl || !config.supabasePublishableKey) {
      throw new Error("Supabase browser config is not set.");
    }

    const baseUrl = String(config.supabaseUrl).replace(/\/+$/, "");
    const table = encodeURIComponent(config.table || "milana_products");
    const source = encodeURIComponent(catalog.sourcePdf);
    const select = [
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
      "is_visible",
      "extraction_status",
      "native_text",
      "ocr_text",
      "combined_text"
    ].join(",");
    const headers = {
      apikey: config.supabasePublishableKey,
      Authorization: `Bearer ${config.supabasePublishableKey}`
    };
    const url = `${baseUrl}/rest/v1/${table}?select=${select}&source_pdf=eq.${source}&is_visible=is.true&order=page.asc,card_index.asc`;
    let response = await fetch(url, {
      headers
    });

    if (!response.ok) {
      const fallbackSelect = select.replace(",material_type", "").replace(",is_visible", "");
      const fallbackUrl = `${baseUrl}/rest/v1/${table}?select=${fallbackSelect}&source_pdf=eq.${source}&order=page.asc,card_index.asc`;
      response = await fetch(fallbackUrl, {
        headers
      });
    }

    if (!response.ok) {
      throw new Error("Supabase returned " + response.status);
    }

    const products = await response.json();
    const visibleProducts = products.filter((product) => isVisible(product));
    if (!visibleProducts.length) {
      throw new Error("Supabase returned no visible products.");
    }

    return visibleProducts;
  }

  async function readFromLocalJson() {
    const response = await fetch(config.localJson || "outputs/catalog_processing/milana_products_latest.json", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Local JSON returned " + response.status);
    }

    const products = await response.json();
    return products.filter((product) => isVisible(product));
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

  function normalizeManualProduct(product) {
    const hasImage = Boolean(product.image_url || product.image_path || product.image_storage_path);
    return Object.assign({}, product, {
      id: product.id || [
        "manual-storage",
        product.source_pdf || catalog.sourcePdf,
        Number(product.page || 0),
        Number(product.card_index || 0)
      ].join(":"),
      source_pdf: product.source_pdf || catalog.sourcePdf,
      currency: product.currency || "USD",
      extraction_status: product.extraction_status || "manual",
      image_missing: hasImage ? false : product.image_missing === true,
      is_visible: product.is_visible !== false,
      manual_storage: true
    });
  }

  function manualProductsStorageUrl() {
    const bucket = config.imageBucket || "product-images";
    return `${String(config.supabaseUrl || "").replace(/\/+$/, "")}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeStoragePath(manualProductsStoragePath())}`;
  }

  function manualProductsStoragePath() {
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    return `${prefix}/manual-products/${safeSourceStem(catalog.sourcePdf)}.json`;
  }

  async function readProductOrderFromStorage() {
    return readCatalogListFromStorage(productOrderStorageUrl(), "order");
  }

  async function readProductVisibilityFromStorage() {
    if (!config.supabaseUrl) {
      return {};
    }

    const response = await fetch(productVisibilityStorageUrl(), { cache: "no-store" });
    if (response.status === 404 || !response.ok) {
      return {};
    }

    const payload = await response.json();
    return hiddenVisibilityOnly(payload && payload.visibility);
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

  function productOrderStorageUrl() {
    const bucket = config.imageBucket || "product-images";
    return `${String(config.supabaseUrl || "").replace(/\/+$/, "")}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeStoragePath(productOrderStoragePath())}`;
  }

  function productOrderStoragePath() {
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    return `${prefix}/product-order/${safeSourceStem(catalog.sourcePdf)}.json`;
  }

  function productVisibilityStorageUrl() {
    const bucket = config.imageBucket || "product-images";
    const cacheBust = "v=" + encodeURIComponent(String(Date.now()));
    return `${String(config.supabaseUrl || "").replace(/\/+$/, "")}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeStoragePath(productVisibilityStoragePath())}?${cacheBust}`;
  }

  function productVisibilityStoragePath() {
    const prefix = (config.adminImagePrefix || "manual-edits").replace(/^\/+|\/+$/g, "");
    return `${prefix}/product-visibility/${safeSourceStem(catalog.sourcePdf)}.json`;
  }

  function isVisible(product) {
    return product.is_visible !== false && product.extraction_status !== LEGACY_HIDDEN_STATUS;
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

  function hiddenVisibilityOnly(visibility) {
    if (!visibility || typeof visibility !== "object" || Array.isArray(visibility)) {
      return {};
    }

    return Object.fromEntries(Object.entries(visibility).filter(([, value]) => value === false));
  }

  function renderProducts() {
    countEl.textContent = state.filtered.length + (state.filtered.length === 1 ? " item" : " items");

    if (!state.filtered.length) {
      gridEl.innerHTML = '<div class="empty">No matching products.</div>';
      return;
    }

    gridEl.innerHTML = state.filtered.map(productCardMarkup).join("");
  }

  function productCardMarkup(product, index) {
    const model = escapeHtml(product.model_code || product.product_code || "Model");
    const code = escapeHtml(product.product_code || product.model_code || "");
    const imageFallbacks = productImageFallbacks(product);
    const fullImage = imageFallbacks[1] || imageFallbacks[0];
    const cardImage = imageFallbacks[0];
    const srcset = isSupabaseImageUrl(cardImage) ? buildCardSrcset(product) : "";
    const loading = index < EAGER_IMAGE_COUNT ? "eager" : "lazy";
    const fetchPriority = index < HIGH_PRIORITY_IMAGE_COUNT ? "high" : "low";
    const price = escapeHtml(formatPrice(product.price, product.currency));
    return `
      <article class="product-card" data-product-index="${index}" role="button" tabindex="0">
        <div class="product-image">
          ${cardImage ? `<img
            src="${escapeAttribute(cardImage)}"
            ${srcset ? `srcset="${escapeAttribute(srcset)}"` : ""}
            sizes="(max-width: 560px) calc((100vw - 38px) / 2), (max-width: 1480px) 22vw, 260px"
            alt="${model}"
            loading="${loading}"
            decoding="async"
            fetchpriority="${fetchPriority}"
            width="${DEFAULT_CARD_IMAGE_WIDTH}"
            height="724"
            data-product-index="${index}"
            data-print-srcs="${escapeAttribute(JSON.stringify(printImageFallbacks(product)))}"
            data-fallback-srcs="${escapeAttribute(JSON.stringify(imageFallbacks.slice(1)))}">` : '<div class="missing-image">No image</div>'}
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

  function openProductModal(index) {
    const product = state.filtered[index];
    if (!product) {
      return;
    }

    const model = product.model_code || product.product_code || "Model";
    const code = product.product_code || product.model_code || "";
    const image = resolveImageUrl(product);
    const price = formatPrice(product.price, product.currency);

    productModalCard.innerHTML = `
      <div class="modal-image">
        ${image ? `<img src="${escapeAttribute(image)}" alt="${escapeAttribute(model)}">` : '<div class="missing-image">No image</div>'}
      </div>
      <div class="modal-info">
        <p class="eyebrow">Product</p>
        <h2 class="model">${escapeHtml(model)}</h2>
        <p class="code">Code ${escapeHtml(code)}</p>
        <p class="price">${escapeHtml(price)}</p>
      </div>
    `;
    productModal.hidden = false;
    document.body.style.overflow = "hidden";
    closeProductModal.focus();
  }

  function closeProductModalView() {
    productModal.hidden = true;
    productModalCard.innerHTML = "";
    document.body.style.overflow = "";
  }

  async function exportCatalogPdf() {
    if (!state.products.length) {
      showStatus("Load products before exporting the catalog.");
      return;
    }

    const previousFiltered = state.filtered.slice();
    const previousTitle = document.title;
    const exportButtons = [exportPdfButton, headerExportPdfButton].filter(Boolean);
    const previousButtonLabels = new Map(exportButtons.map((button) => [button, button.textContent]));
    setExportButtons(exportButtons, true, "Preparing...");
    showStatus("Preparing PDF images...");

    const finishExport = () => {
      window.removeEventListener("afterprint", finishExport);
      document.body.classList.remove("pdf-exporting");
      document.title = previousTitle;
      state.filtered = previousFiltered;
      renderProducts();
      hideStatus();
      exportButtons.forEach((button) => {
        button.disabled = false;
        button.textContent = previousButtonLabels.get(button) || "PDF";
      });
    };

    try {
      document.body.classList.add("pdf-exporting");
      state.filtered = state.products.slice();
      renderProducts();
      await nextFrame();
      await prepareImagesForPdf();
      document.title = pdfDocumentTitle();
      setExportButtons(exportButtons, true, "Save PDF");
      window.addEventListener("afterprint", finishExport, { once: true });
      window.print();
    } catch (error) {
      console.error(error);
      finishExport();
      showStatus("PDF export could not be prepared. Try again after the images finish loading.");
    }
  }

  function setExportButtons(buttons, disabled, text) {
    buttons.forEach((button) => {
      button.disabled = disabled;
      button.textContent = text;
    });
  }

  async function prepareImagesForPdf() {
    const images = Array.from(gridEl.querySelectorAll(".product-image img"));
    images.forEach((img) => {
      usePrintImage(img);
      img.loading = "eager";
      img.fetchPriority = "high";
    });

    await Promise.all(images.map((img) => waitForImage(img)));
  }

  async function waitForImage(img, attempt = 0) {
    if (img.complete && img.naturalWidth > 0) {
      return;
    }

    await new Promise((resolve) => {
      const done = () => {
        img.removeEventListener("load", done);
        img.removeEventListener("error", done);
        resolve();
      };
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
      window.setTimeout(done, 6000);
    });

    if ((img.complete && img.naturalWidth > 0) || attempt >= 5) {
      return;
    }

    if (useNextImageFallback(img)) {
      await waitForImage(img, attempt + 1);
    }
  }

  function nextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function pdfDocumentTitle() {
    return [
      "Milana Premium",
      "Catalog " + String(catalog.id).padStart(2, "0"),
      (catalog.titles.en || titleEl.textContent || "Catalog").replace(/[\\/:*?"<>|]+/g, " ")
    ].join(" - ");
  }

  function resolveImageUrl(product) {
    if (!hasProductImage(product)) {
      return "";
    }

    const explicitImage = String(product.image_url || "").trim();
    if (explicitImage && (!product.image_path || isManualImageUrl(explicitImage))) {
      return explicitImage;
    }

    const localImage = localProductImageUrl(product) || derivedLocalImageUrl(product, "storage_images");
    if (localImage) {
      return localImage;
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

  function resolveCardImageUrl(product, width) {
    return supabaseRenderImageUrl(product, width) || resolveImageUrl(product) || localStorageImageUrl(product);
  }

  function productImageFallbacks(product) {
    if (!hasProductImage(product)) {
      return [];
    }

    return uniqueValues([
      manualImageUrl(product),
      derivedLocalImageUrl(product, "storage_images"),
      derivedLocalImageUrl(product, "images"),
      localProductImageUrl(product),
      localStorageImageUrl(product),
      supabaseRenderImageUrl(product, DEFAULT_CARD_IMAGE_WIDTH),
      product.image_url
    ]);
  }

  function printImageFallbacks(product) {
    if (!hasProductImage(product)) {
      return [];
    }

    return uniqueValues([
      manualPrintImageUrl(product),
      manualImageUrl(product),
      derivedLocalImageUrl(product, "storage_images"),
      derivedLocalImageUrl(product, "images"),
      localProductImageUrl(product),
      localStorageImageUrl(product),
      resolveImageUrl(product),
      supabaseRenderImageUrl(product, 1200, 76),
      supabaseRenderImageUrl(product, 1000, 74),
      product.image_url
    ]);
  }

  function buildCardSrcset(product) {
    if (!hasProductImage(product)) {
      return "";
    }

    const entries = CARD_IMAGE_WIDTHS
      .map((width) => {
        const url = supabaseRenderImageUrl(product, width);
        return url ? `${url} ${width}w` : "";
      })
      .filter(Boolean);

    return entries.join(", ");
  }

  function supabaseRenderImageUrl(product, width, quality = 74) {
    const storageRef = storageRefFromProduct(product);
    const baseUrl = String(config.supabaseUrl || "").replace(/\/+$/, "");
    if (!storageRef || !baseUrl) {
      return "";
    }

    const params = new URLSearchParams({
      width: String(width),
      quality: String(quality),
      resize: "contain"
    });
    return `${baseUrl}/storage/v1/render/image/public/${encodeURIComponent(storageRef.bucket)}/${encodeStoragePath(storageRef.path)}?${params}`;
  }

  function isSupabaseImageUrl(value) {
    return String(value || "").includes("/storage/v1/");
  }

  function isManualImageUrl(value) {
    return String(value || "").includes("/manual-edits/");
  }

  function manualImageUrl(product) {
    const explicitImage = String((product && product.image_url) || "").trim();
    return isManualImageUrl(explicitImage) ? explicitImage : "";
  }

  function manualPrintImageUrl(product) {
    return manualImageUrl(product) ? supabaseRenderImageUrl(product, 1200, 76) : "";
  }

  function localStorageImageUrl(product) {
    const image = resolveImageUrl(product);
    const marker = "outputs/catalog_processing/images/latest/";
    if (!image.includes(marker)) {
      return "";
    }

    return image.replace(marker, "outputs/catalog_processing/storage_images/latest/");
  }

  function derivedLocalImageUrl(product, folder) {
    const stem = safeSourceStem(product.source_pdf);
    const page = padNumber(product.page);
    const card = padNumber(product.card_index);
    if (!stem || !page || !card) {
      return "";
    }

    return versionLocalImageUrl(`outputs/catalog_processing/${folder}/latest/${stem}_p${page}_c${card}.jpg`);
  }

  function versionLocalImageUrl(value) {
    const url = String(value || "");
    if (!url || url.includes("?") || !url.startsWith("outputs/")) {
      return url;
    }

    return `${url}?v=${LOCAL_IMAGE_VERSION}`;
  }

  function safeSourceStem(value) {
    const name = String(value || "").split(/[\\/]/).pop().replace(/\.pdf$/i, "");
    return name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "";
  }

  function padNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      return "";
    }

    return String(Math.trunc(number)).padStart(3, "0");
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

  function storageRefFromProduct(product) {
    if (!hasProductImage(product)) {
      return null;
    }

    const parsedFromUrl = parseSupabasePublicImageUrl(product.image_url);
    if (parsedFromUrl) {
      return parsedFromUrl;
    }

    if (product.image_url && !product.image_storage_path) {
      return null;
    }

    const path = String(product.image_storage_path || "").trim().replace(/^\/+/, "");
    if (!path) {
      return null;
    }

    return {
      bucket: String(product.image_storage_bucket || config.imageBucket || "product-images"),
      path
    };
  }

  function parseSupabasePublicImageUrl(value) {
    const url = String(value || "");
    const markers = [
      "/storage/v1/object/public/",
      "/storage/v1/render/image/public/"
    ];
    const marker = markers.find((item) => url.includes(item));
    if (!marker) {
      return null;
    }

    const pathPart = url.slice(url.indexOf(marker) + marker.length).split(/[?#]/)[0];
    const parts = pathPart.split("/").filter(Boolean);
    const bucket = parts.shift();
    if (!bucket || !parts.length) {
      return null;
    }

    return {
      bucket: decodeStoragePart(bucket),
      path: parts.map(decodeStoragePart).join("/")
    };
  }

  function encodeStoragePath(value) {
    return String(value)
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
  }

  function decodeStoragePart(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  function handleGridImageError(event) {
    const img = event.target instanceof HTMLImageElement ? event.target : null;
    if (!img) {
      return;
    }

    useNextImageFallback(img);
  }

  function usePrintImage(img) {
    const printSources = readImageList(img.dataset.printSrcs);
    if (!printSources.length) {
      return;
    }

    const [source, ...fallbacks] = printSources;
    img.removeAttribute("srcset");
    img.sizes = "100vw";
    img.dataset.fallbackSrcs = JSON.stringify(fallbacks);
    if (source && img.src !== source) {
      img.src = source;
    }
  }

  function useNextImageFallback(img) {
    const fallbacks = readImageFallbacks(img);
    if (!fallbacks.length) {
      showMissingImage(img);
      return false;
    }

    const fallback = fallbacks.shift();
    img.dataset.fallbackSrcs = JSON.stringify(fallbacks);
    if (!fallback || img.currentSrc === fallback || img.src === fallback) {
      return useNextImageFallback(img);
    }

    img.removeAttribute("srcset");
    img.src = fallback;
    return true;
  }

  function showMissingImage(img) {
    const wrapper = img.closest(".product-image");
    if (!wrapper) {
      return;
    }

    wrapper.innerHTML = '<div class="missing-image">No image</div>';
  }

  function readImageFallbacks(img) {
    return readImageList(img.dataset.fallbackSrcs);
  }

  function readImageList(value) {
    try {
      const values = JSON.parse(value || "[]");
      return Array.isArray(values) ? values.filter(Boolean) : [];
    } catch (error) {
      return [];
    }
  }

  function preconnectTo(value) {
    if (!value) {
      return;
    }

    let origin = "";
    try {
      origin = new URL(value).origin;
    } catch (error) {
      return;
    }

    ["preconnect", "dns-prefetch"].forEach((rel) => {
      const link = document.createElement("link");
      link.rel = rel;
      link.href = origin;
      if (rel === "preconnect") {
        link.crossOrigin = "";
      }
      document.head.appendChild(link);
    });
  }

  function formatPrice(value, currency) {
    const number = Number(value);
    const clean = Number.isFinite(number) ? number.toFixed(2).replace(/\.00$/, "").replace(/0$/, "") : String(value || "");
    if (!clean) {
      return "";
    }
    return currency === "USD" || !currency ? "$" + clean : clean + " " + currency;
  }

  function searchableText(item) {
    return [
      item.model_code,
      item.product_code,
      materialType(item),
      item.price,
      item.currency,
      item.source_pdf
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
