"use strict";

// Search/review UI for media metadata. Heavy source files stay outside Git;
// cards refer to paths and only load previews when they become visible.
(function (app) {
  class MaterialBackpack {
    constructor(options) {
      this.options = options;
      this.data = options.data || { clusters: [], item_count: 0 };
      this.collections = [...(this.data.themes || []), ...(this.data.clusters || [])];
      this.map = options.map;
      this.activeCluster = null;
      this.selectedItem = null;
      this.overlay = document.getElementById("material-backpack");
      this.clusterList = document.getElementById("backpack-clusters");
      this.grid = document.getElementById("backpack-grid");
      this.main = document.querySelector(".backpack-main");
      this.main.tabIndex = -1;
      this.title = document.getElementById("backpack-cluster-title");
      this.count = document.getElementById("backpack-cluster-count");
      this.locateClusterButton = document.getElementById("backpack-locate-cluster");
      this.selectedFile = document.getElementById("backpack-selected-file");
      this.copyButton = document.getElementById("backpack-copy-file");
      this.copyBadButton = document.getElementById("backpack-copy-bad");
      this.selectionCancelButton = document.getElementById("backpack-selection-cancel");
      this.selectionConfirmButton = document.getElementById("backpack-selection-confirm");
      this.search = document.getElementById("backpack-search");
      this.scope = document.getElementById("backpack-scope");
      this.kindFilter = document.getElementById("backpack-kind-filter");
      this.preview = document.getElementById("backpack-preview");
      this.previewImage = document.getElementById("backpack-preview-image");
      this.previewVideo = document.getElementById("backpack-preview-video");
      this.previewFallback = document.getElementById("backpack-preview-fallback");
      this.overlay.inert = true;
      this.preview.inert = true;
      this.reviewFilter = document.getElementById("backpack-review-filter");
      this.reviewState = this.loadReviewState();
      this.migrateRelatedReviewState();
      this.previewItem = null;
      this.previewReturnItemId = null;
      this.previewMainScrollTop = 0;
      this.previewClusterScrollTop = 0;
      this.lastFocus = null;
      this.selectionMode = false;
      this.selectionPaths = new Set();
      this.selectionCallback = null;
      this.markerEntries = [];
      this.thumbnailObserver = this.createThumbnailObserver();
      this.bindEvents();
      this.renderClusters();
      this.updateStats();
      this.attachMapMarkers();
    }

    createThumbnailObserver() {
      // Lazy thumbnails keep the large metadata catalog usable without
      // requesting every local preview during page startup.
      if (!("IntersectionObserver" in window)) return null;
      return new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const video = entry.target;
            if (entry.isIntersecting && this.overlay.classList.contains("show")) {
              if (!video.getAttribute("src") && video.dataset.src) {
                video.src = video.dataset.src;
                video.load();
              }
              video.play().catch(() => {});
            } else {
              video.pause();
            }
          });
        },
        { root: this.main, rootMargin: "80px 0px", threshold: 0.05 },
      );
    }

    assetUrl(path) {
      if (!path || !/_preview\.jpg$/i.test(path)) return path;
      return `${path}${path.includes("?") ? "&" : "?"}v=20260705-heic-main-v2`;
    }

    bindEvents() {
      document.getElementById("btn-backpack").onclick = () => this.open();
      document.getElementById("backpack-close").onclick = () => this.close();
      this.overlay.addEventListener("click", (event) => {
        if (event.target === this.overlay) this.close();
      });
      document.addEventListener("keydown", (event) => this.handleKeydown(event));
      this.copyButton.onclick = () => this.copySelectedFile();
      this.copyBadButton.onclick = () => this.copyBadList();
      this.selectionCancelButton.onclick = () => this.close();
      this.selectionConfirmButton.onclick = () => this.confirmSelection();
      this.search.oninput = () => this.renderItems();
      this.scope.onchange = () => this.renderItems();
      this.kindFilter.onchange = () => this.renderItems();
      this.reviewFilter.onchange = () => this.renderItems();
      document.getElementById("backpack-preview-close").onclick = () => this.closePreview();
      this.previewVideo.onerror = () => {
        this.previewVideo.style.display = "none";
        this.previewFallback.style.display = "grid";
      };
      this.preview.addEventListener("click", (event) => {
        if (event.target === this.preview) this.closePreview();
      });
      document.getElementById("backpack-mark-keep").onclick = () => this.setReview(this.previewItem, "keep");
      document.getElementById("backpack-mark-bad").onclick = () => this.setReview(this.previewItem, "bad");
      document.getElementById("backpack-mark-clear").onclick = () => this.setReview(this.previewItem, null);
      document.getElementById("backpack-preview-copy").onclick = () => this.copySelectedFile();
      this.locateClusterButton.onclick = () => this.locateCluster(this.activeCluster);
    }

    handleKeydown(event) {
      if (!this.overlay.classList.contains("show")) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        if (this.preview.classList.contains("show")) this.closePreview();
        else this.close();
        return;
      }
      if (event.key !== "Tab") return;
      const root = this.preview.classList.contains("show") ? this.preview : this.overlay.querySelector(".backpack-shell");
      const focusable = [...root.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    attachMapMarkers() {
      if (!this.map || typeof maplibregl === "undefined") return;
      const add = () => {
        if (this.markerEntries.length) return;
        this.markerEntries = this.data.clusters.map((cluster) => {
          const element = document.createElement("button");
          element.type = "button";
          element.className = "material-cluster-marker";
          element.title = `${cluster.label} · ${cluster.items.length} 件素材`;
          element.setAttribute("aria-label", element.title);
          element.innerHTML = `<span>◇</span><b>${cluster.items.length}</b>`;
          element.onclick = (event) => {
            event.stopPropagation();
            this.open(cluster.id);
          };
          const marker = new maplibregl.Marker({ element, anchor: "center" })
            .setLngLat(cluster.center)
            .addTo(this.map);
          return { cluster, element, marker };
        });
        this.syncMarkerVisibility();
        this.updateMarkerStates();
      };
      if (this.map.loaded()) add();
      else this.map.once("load", add);
      this.map.on("zoomend", () => this.syncMarkerVisibility());
    }

    syncMarkerVisibility() {
      const visible = this.map.getZoom() >= 6.2;
      this.markerEntries.forEach(({ element }) => {
        element.style.display = visible ? "grid" : "none";
      });
    }

    updateMarkerStates() {
      this.markerEntries.forEach(({ cluster, element }) => {
        const bad = cluster.items.filter((item) => this.reviewState[item.id] === "bad").length;
        element.classList.toggle("has-bad", bad > 0);
        element.querySelector("b").textContent = bad ? `${bad}/${cluster.items.length}` : cluster.items.length;
      });
    }

    loadReviewState() {
      // Review decisions are local authoring state, not route or timeline
      // authority; generated data can be rebuilt without losing these flags.
      try {
        return JSON.parse(localStorage.getItem("tibet-media-review-v1") || "{}") || {};
      } catch (_error) {
        return {};
      }
    }

    migrateRelatedReviewState() {
      let changed = false;
      this.collections.flatMap((collection) => collection.items).forEach((item) => {
        if (!Array.isArray(item.related_files) || item.related_files.length < 2) return;
        const relatedStates = item.related_files
          .filter((path) => path !== item.id)
          .map((path) => this.reviewState[path])
          .filter((state) => state === "keep" || state === "bad");
        if (!this.reviewState[item.id] && relatedStates.length) {
          this.reviewState[item.id] = relatedStates.includes("bad") ? "bad" : "keep";
          changed = true;
        }
        item.related_files.forEach((path) => {
          if (path !== item.id && Object.prototype.hasOwnProperty.call(this.reviewState, path)) {
            delete this.reviewState[path];
            changed = true;
          }
        });
      });
      if (changed) this.saveReviewState();
    }

    saveReviewState() {
      try {
        localStorage.setItem("tibet-media-review-v1", JSON.stringify(this.reviewState));
      } catch (_error) {
        this.showToast("无法保存本地标记");
      }
    }

    reviewCounts() {
      return this.collections.flatMap((collection) => collection.items).reduce(
        (counts, value) => {
          const state = this.reviewState[value.id];
          if (state === "keep" || state === "bad") counts[state] += 1;
          return counts;
        },
        { keep: 0, bad: 0 },
      );
    }

    updateStats() {
      const counts = this.reviewCounts();
      document.getElementById("backpack-stats").textContent =
        `${this.data.theme_count || 0} 个主题 · ${this.data.cluster_count || 0} 个轨迹地点 · ` +
        `${this.data.item_count || 0} 件素材 · 保留 ${counts.keep} · 不好 ${counts.bad}`;
      this.copyBadButton.textContent = `复制不好清单 (${counts.bad})`;
      this.copyBadButton.disabled = counts.bad === 0;
    }

    renderClusters() {
      this.clusterList.replaceChildren();
      const groups = [
        { label: "主题素材", items: this.data.themes || [] },
        { label: "轨迹地点", items: this.data.clusters || [] },
      ];
      groups.forEach((group) => {
        if (!group.items.length) return;
        const heading = document.createElement("div");
        heading.className = "backpack-group-label";
        heading.textContent = group.label;
        this.clusterList.append(heading);
        group.items.forEach((cluster) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "backpack-cluster-tab";
          button.classList.toggle("theme", cluster.group_type === "theme");
          button.setAttribute("role", "tab");
          button.setAttribute("aria-selected", "false");
          button.dataset.clusterId = cluster.id;
          const label = document.createElement("span");
          label.textContent = cluster.label;
          const count = document.createElement("b");
          count.textContent = cluster.items.length;
          button.append(label, count);
          button.onclick = () => this.openCluster(cluster.id);
          this.clusterList.append(button);
        });
      });
    }

    visibleItems() {
      const clusters = this.scope.value === "all" ? this.collections : this.activeCluster ? [this.activeCluster] : [];
      const query = this.search.value.trim().toLocaleLowerCase();
      const kind = this.kindFilter.value;
      const review = this.reviewFilter.value;
      return clusters.flatMap((cluster) =>
        cluster.items
          .filter((item) => kind === "all" || item.kind === kind)
          .filter((item) => {
            const state = this.reviewState[item.id];
            if (review === "unreviewed") return !state;
            return review === "all" || state === review;
          })
          .filter((item) => !query || item.path.toLocaleLowerCase().includes(query))
          .map((item) => ({ item, cluster })),
      );
    }

    renderItems() {
      this.thumbnailObserver?.disconnect();
      this.grid.replaceChildren();
      const visible = this.visibleItems();
      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "backpack-empty";
        empty.textContent = "没有匹配的素材";
        this.grid.append(empty);
      }
      visible.forEach(({ item, cluster }) => {
        const card = document.createElement("article");
        card.className = "backpack-item";
        card.dataset.itemId = item.id;
        const review = this.reviewState[item.id];
        if (review) card.classList.add(`review-${review}`);
        if (this.selectionMode && this.selectionPaths.has(item.path)) card.classList.add("story-selected");
        card.title = item.path;
        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "backpack-item-open";
        openButton.setAttribute("aria-label", `预览 ${item.name}`);
        const visual = document.createElement("span");
        visual.className = "backpack-item-visual";
        if (item.preview_role === "live_photo") visual.classList.add("live-photo");
        if (item.preview_role === "live_photo" && item.preview) {
          const video = document.createElement("video");
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.preload = "metadata";
          video.tabIndex = -1;
          video.setAttribute("aria-hidden", "true");
          video.disablePictureInPicture = true;
          video.onerror = () => visual.classList.add("preview-error");
          visual.append(video);
          if (this.thumbnailObserver) {
            video.dataset.src = item.preview;
            this.thumbnailObserver.observe(video);
          } else {
            video.src = item.preview;
            video.addEventListener("loadeddata", () => video.play().catch(() => {}), { once: true });
          }
        } else if (item.poster) {
          const image = document.createElement("img");
          image.src = this.assetUrl(item.poster);
          image.alt = "";
          image.loading = "lazy";
          image.onerror = () => visual.classList.add("preview-error");
          visual.append(image);
        }
        const kind = document.createElement("i");
        kind.textContent =
          item.preview_role === "live_photo" ? "LIVE" : item.kind === "video" ? "VIDEO" : "PHOTO";
        visual.append(kind);
        const name = document.createElement("strong");
        name.textContent = item.name;
        const meta = document.createElement("small");
        const time = item.capture_time ? item.capture_time.slice(5, 16).replace("T", " ") : "时间未知";
        const themeMeta = [item.catalog_rating, item.theme_tag, time].filter(Boolean).join(" · ");
        meta.textContent = cluster.group_type === "theme"
          ? themeMeta
          : this.scope.value === "all" ? `${cluster.label} · ${time}` : time;
        const badge = document.createElement("em");
        badge.className = "backpack-review-badge";
        badge.textContent = review === "bad" ? "不好" : review === "keep" ? "保留" : "";
        const badButton = document.createElement("button");
        badButton.type = "button";
        badButton.className = "backpack-item-bad";
        badButton.classList.toggle("active", review === "bad");
        badButton.textContent = review === "bad" ? "已标记不好 · 取消" : "标记为不好";
        badButton.setAttribute("aria-pressed", String(review === "bad"));
        badButton.setAttribute(
          "aria-label",
          review === "bad" ? `取消 ${item.name} 的不好标记` : `将 ${item.name} 标记为不好`,
        );
        openButton.append(visual, name, meta);
        card.append(openButton, badButton, badge);
        openButton.onclick = () => this.selectItem(item, card, true);
        badButton.onclick = () => this.setReview(item, review === "bad" ? null : "bad");
        this.grid.append(card);
      });
      this.count.textContent = `${visible.length} 件素材`;
    }

    selectItem(item, card, showPreview = false) {
      this.selectedItem = item;
      if (this.selectionMode) {
        if (this.selectionPaths.has(item.path)) this.selectionPaths.delete(item.path);
        else this.selectionPaths.add(item.path);
        card.classList.toggle("story-selected", this.selectionPaths.has(item.path));
        this.selectedFile.textContent = this.selectionPaths.size
          ? `已选 ${this.selectionPaths.size} 件 · ${item.path}`
          : "点击素材卡选择，可多选";
        this.selectionConfirmButton.textContent = `加入故事点 (${this.selectionPaths.size})`;
        this.selectionConfirmButton.disabled = this.selectionPaths.size === 0;
        return;
      }
      this.grid.querySelectorAll(".selected").forEach((node) => node.classList.remove("selected"));
      card.classList.add("selected");
      this.selectedFile.textContent = item.path;
      this.copyButton.disabled = false;
      if (showPreview) this.openPreview(item);
    }

    openPreview(item) {
      this.previewItem = item;
      this.previewReturnItemId = item.id;
      this.previewMainScrollTop = this.main.scrollTop;
      this.previewClusterScrollTop = this.clusterList.scrollTop;
      this.previewImage.removeAttribute("src");
      this.previewVideo.pause();
      this.previewVideo.removeAttribute("src");
      this.previewVideo.removeAttribute("poster");
      this.previewVideo.loop = false;
      this.previewVideo.load();
      this.previewImage.style.display = "none";
      this.previewVideo.style.display = "none";
      this.previewFallback.style.display = "none";
      if (item.preview_type === "image" && item.preview) {
        this.previewImage.src = this.assetUrl(item.preview);
        this.previewImage.alt = item.name;
        this.previewImage.style.display = "block";
        this.previewImage.onerror = () => {
          this.previewImage.style.display = "none";
          this.previewFallback.style.display = "grid";
        };
      } else if (item.preview_type === "video" && item.preview) {
        this.previewVideo.src = item.preview;
        if (item.poster) this.previewVideo.poster = this.assetUrl(item.poster);
        this.previewVideo.loop = item.preview_role === "live_photo";
        this.previewVideo.style.display = "block";
        this.previewVideo.load();
        if (item.preview_role === "live_photo") this.previewVideo.play().catch(() => {});
      } else {
        this.previewFallback.style.display = "grid";
      }
      document.getElementById("backpack-preview-kind").textContent =
        item.preview_role === "live_photo" ? "实况照片 · LIVE" : item.kind === "video" ? "旅行视频" : "旅行照片";
      document.getElementById("backpack-preview-name").textContent = item.name;
      document.getElementById("backpack-preview-path").textContent = item.path;
      this.updateReviewActions(item);
      this.preview.classList.add("show");
      this.preview.inert = false;
      this.preview.setAttribute("aria-hidden", "false");
      document.getElementById("backpack-preview-close").focus();
    }

    closePreview() {
      this.previewVideo.pause();
      this.previewVideo.removeAttribute("src");
      this.previewVideo.load();
      this.preview.classList.remove("show");
      this.preview.setAttribute("aria-hidden", "true");
      this.preview.inert = true;
      this.previewItem = null;
      if (this.overlay.classList.contains("show")) {
        const returnCard = [...this.grid.querySelectorAll(".backpack-item")].find(
          (card) => card.dataset.itemId === this.previewReturnItemId,
        );
        const returnTarget = returnCard?.querySelector(".backpack-item-open") || this.main;
        returnTarget.focus({ preventScroll: true });
        this.main.scrollTop = this.previewMainScrollTop;
        this.clusterList.scrollTop = this.previewClusterScrollTop;
      }
      this.previewReturnItemId = null;
    }

    updateReviewActions(item) {
      const state = item ? this.reviewState[item.id] : null;
      document.getElementById("backpack-mark-keep").classList.toggle("active", state === "keep");
      document.getElementById("backpack-mark-bad").classList.toggle("active", state === "bad");
      document.getElementById("backpack-mark-clear").disabled = !state;
    }

    setReview(item, state) {
      if (!item) return;
      if (state) this.reviewState[item.id] = state;
      else delete this.reviewState[item.id];
      this.saveReviewState();
      this.updateReviewActions(item);
      this.updateStats();
      this.updateMarkerStates();
      this.renderItems();
    }

    locateCluster(cluster) {
      if (!cluster || cluster.group_type === "theme" || typeof this.options.onLocateCluster !== "function") return;
      this.closePreview();
      this.close();
      this.options.onLocateCluster(cluster);
    }

    async copySelectedFile() {
      if (!this.selectedItem) return;
      await this.copyText(this.selectedItem.path);
      this.showToast(`已复制：${this.selectedItem.name}`);
    }

    async copyBadList() {
      const badPaths = this.collections
        .flatMap((collection) => collection.items)
        .filter((item) => this.reviewState[item.id] === "bad")
        .map((item) => item.path);
      if (!badPaths.length) {
        this.showToast("还没有标记不好的素材");
        return;
      }
      await this.copyText("不好的素材：\n" + badPaths.join("\n"));
      this.showToast(`已复制 ${badPaths.length} 个不好素材的文件名`);
    }

    async copyText(value) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    showToast(message) {
      const toast = document.getElementById("backpack-toast");
      toast.textContent = message;
      toast.classList.add("show");
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
    }

    open(clusterId) {
      this.lastFocus = document.activeElement;
      this.overlay.classList.add("show");
      this.overlay.setAttribute("aria-hidden", "false");
      this.overlay.inert = false;
      document.body.classList.add("backpack-open");
      this.openCluster(clusterId || this.activeCluster?.id || this.collections[0]?.id);
      document.getElementById("backpack-close").focus();
    }

    openSelection({ selectedPaths = [], onConfirm, clusterId } = {}) {
      // Selection mode is shared with ManualStoryEditor but remains optional so
      // the backpack can still be used as a standalone review browser.
      this.selectionMode = true;
      this.selectionPaths = new Set(selectedPaths);
      this.selectionCallback = typeof onConfirm === "function" ? onConfirm : null;
      this.overlay.classList.add("selection-mode");
      this.selectionCancelButton.hidden = false;
      this.selectionConfirmButton.hidden = false;
      this.selectionConfirmButton.disabled = this.selectionPaths.size === 0;
      this.selectionConfirmButton.textContent = `加入故事点 (${this.selectionPaths.size})`;
      document.getElementById("backpack-title").textContent = "为故事点选择素材";
      this.selectedFile.textContent = this.selectionPaths.size
        ? `已选 ${this.selectionPaths.size} 件素材`
        : "点击素材卡选择，可多选";
      this.open(clusterId);
    }

    confirmSelection() {
      if (!this.selectionMode || !this.selectionPaths.size) return;
      const paths = [...this.selectionPaths];
      const callback = this.selectionCallback;
      this.close();
      callback?.(paths);
    }

    resetSelectionMode() {
      this.selectionMode = false;
      this.selectionPaths.clear();
      this.selectionCallback = null;
      this.overlay.classList.remove("selection-mode");
      this.selectionCancelButton.hidden = true;
      this.selectionConfirmButton.hidden = true;
      document.getElementById("backpack-title").textContent = "旅行素材背包";
      this.selectedFile.textContent = this.selectedItem?.path || "点击素材卡查看文件名";
    }

    close() {
      this.closePreview();
      this.grid.querySelectorAll("video").forEach((video) => video.pause());
      this.overlay.classList.remove("show");
      this.overlay.setAttribute("aria-hidden", "true");
      this.overlay.inert = true;
      document.body.classList.remove("backpack-open");
      this.resetSelectionMode();
      if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
      else document.getElementById("btn-backpack").focus();
    }

    openCluster(clusterId) {
      const cluster = this.collections.find((item) => String(item.id) === String(clusterId));
      if (!cluster) return;
      this.activeCluster = cluster;
      const isTheme = cluster.group_type === "theme";
      this.locateClusterButton.disabled = isTheme;
      this.locateClusterButton.hidden = isTheme;
      document.getElementById("backpack-cluster-kicker").textContent =
        isTheme ? cluster.kicker || "主 题 素 材" : "轨 迹 地 点";
      this.scope.value = "cluster";
      this.title.textContent = cluster.label;
      const assignedDate = cluster.items.find((item) => item.source_theme_id)?.capture_time?.slice(0, 10);
      const anchors = cluster.media_capture_time_anchors || [];
      const activeAnchor = anchors.find((anchor) => anchor.date === assignedDate);
      const anchorText = activeAnchor
        ? ` · 素材时间锚点 ${activeAnchor.time.slice(11, 16)}`
        : !isTheme && anchors.length > 1 ? ` · ${anchors.length} 个时间锚点` : "";
      this.count.textContent = `${cluster.items.length} 件素材${anchorText}`;
      this.clusterList.querySelectorAll(".active").forEach((node) => node.classList.remove("active"));
      this.clusterList.querySelectorAll("[role='tab']").forEach((node) => node.setAttribute("aria-selected", "false"));
      const activeTab = this.clusterList.querySelector(`[data-cluster-id="${cluster.id}"]`);
      activeTab?.classList.add("active");
      activeTab?.setAttribute("aria-selected", "true");
      this.renderItems();
    }
  }

  app.MaterialBackpack = MaterialBackpack;
})(window.RouteDemo || (window.RouteDemo = {}));
