// FastPath Figma Plugin: code.js
// Scans frames, sections, reactions (destinationId), exports images, and sends to UI

figma.showUI(__html__, { width: 460, height: 580, themeColors: true });

// Check if a node belongs to the current active page
function isNodeOnCurrentPage(node) {
  if (!node) return false;
  let curr = node;
  let depth = 0;
  while (curr && depth < 30) {
    if (curr.type === 'PAGE') {
      return typeof figma !== 'undefined' && figma.currentPage ? curr.id === figma.currentPage.id : true;
    }
    curr = curr.parent;
    depth++;
  }
  return false;
}

// Metadata store for exportable frames (prevents mutating non-extensible Figma SceneNode C++ proxies)
const frameMetaMap = new Map();

function getFrameMeta(nodeOrId: any) {
  const nodeId = typeof nodeOrId === 'string' ? nodeOrId : (nodeOrId && nodeOrId.id ? nodeOrId.id : '');
  if (!nodeId) return { isOverlay: false, closeOnClickOutside: true };
  if (!frameMetaMap.has(nodeId)) {
    frameMetaMap.set(nodeId, {
      isOverlay: false,
      overlayPosition: undefined,
      closeOnClickOutside: true,
      overlayBackground: undefined,
      autoTransition: undefined
    });
  }
  return frameMetaMap.get(nodeId);
}
const getMetadata = getFrameMeta;

// Strict validator to ensure only true screens and overlays are exported
function isRealScreen(node) {
  if (!node || node.visible === false) return false;
  if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') return false;

  // Variants inside a COMPONENT_SET are never top-level prototype screens!
  if (node.parent && node.parent.type === 'COMPONENT_SET') return false;

  // Must be on the current active page
  if (typeof figma !== 'undefined' && figma.currentPage && !isNodeOnCurrentPage(node)) {
    return false;
  }

  // Real full screen (mobile, tablet, desktop)
  if (node.width >= 240 && node.height >= 400) {
    // Check if it's a giant container canvas organizing multiple screens
    const isGiantFlowContainer = node.width >= 1600 && node.height >= 1200 &&
      'children' in node && Array.isArray(node.children) &&
      node.children.filter(function(c) {
        return (c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'INSTANCE') &&
          c.width >= 240 && c.height >= 400 && c.visible !== false;
      }).length >= 2;

    if (isGiantFlowContainer) return false;
    return true;
  }

  // Overlay / bottom sheet / modal / popup
  if (node.width >= 80 && node.height >= 40) {
    const isOverlayByNameOrProp = Boolean(
      node.overlayPositionType ||
      (node.id && frameMetaMap.has(node.id) && frameMetaMap.get(node.id).isOverlay) ||
      (node.name && typeof node.name === 'string' && (
        node.name.toLowerCase().includes('overlay') ||
        node.name.toLowerCase().includes('оверлей') ||
        node.name.toLowerCase().includes('sheet') ||
        node.name.toLowerCase().includes('popup') ||
        node.name.toLowerCase().includes('попап') ||
        node.name.toLowerCase().includes('шторка') ||
        node.name.toLowerCase().includes('модал') ||
        node.name.toLowerCase().includes('modal') ||
        node.name.toLowerCase().includes('диалог') ||
        node.name.toLowerCase().includes('dialog') ||
        node.name.toLowerCase().includes('alert') ||
        node.name.toLowerCase().includes('drawer') ||
        node.name.toLowerCase().includes('tooltip') ||
        node.name.toLowerCase().includes('card') ||
        node.name.toLowerCase().includes('карточк')
      ))
    );
    return isOverlayByNameOrProp;
  }

  return false;
}

// Collect all screen-level frames from current page (root frames, sections, groups)
function findAllScreenFrames(page) {
  const frames = [];
  const visited = new Set();

  function scanCandidate(node) {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);

    // Skip hidden elements
    if (node.visible === false) return;

    // 1. SECTION or GROUP: spatial organizers on canvas -> recurse into children
    if (node.type === 'SECTION' || node.type === 'GROUP') {
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          scanCandidate(child);
        }
      }
      return;
    }

    // 2. Never scan into COMPONENT_SET (set of variants)
    if (node.type === 'COMPONENT_SET') {
      return;
    }

    // 3. Check if node is an oversized container artboard containing multiple separate screen frames
    if ((node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') &&
        node.width >= 1600 && node.height >= 1200 &&
        'children' in node && Array.isArray(node.children)) {
      const screenChildren = node.children.filter(function(c) { return isRealScreen(c); });
      if (screenChildren.length >= 2) {
        for (const child of node.children) {
          scanCandidate(child);
        }
        return;
      }
    }

    // 4. Valid screen or overlay frame
    if (isRealScreen(node)) {
      frames.push(node);
      // CRITICAL: DO NOT recurse into children of a screen!
      // The children are buttons, cards, headers, icons of this screen.
      return;
    }
  }

  if (page && page.children) {
    for (const child of page.children) {
      scanCandidate(child);
    }
  }

  return frames;
}

// Fast memoized resolver for destination frames
function createDestinationResolver(allScreens) {
  const destinationCache = new Map();
  const screenMap = new Map();

  if (allScreens && Array.isArray(allScreens)) {
    for (const s of allScreens) {
      if (s && s.id) {
        screenMap.set(s.id, s);
      }
    }
  }

  return function resolveDestination(nodeId) {
    if (!nodeId) return null;
    if (destinationCache.has(nodeId)) {
      return destinationCache.get(nodeId);
    }

    // 1. Direct hit in allScreens
    if (screenMap.has(nodeId)) {
      const found = screenMap.get(nodeId);
      destinationCache.set(nodeId, found);
      return found;
    }

    let node = null;
    try {
      if (typeof figma !== 'undefined' && figma.getNodeById) {
        node = figma.getNodeById(nodeId);
      }
    } catch (e) {
      node = null;
    }

    if (!node) {
      destinationCache.set(nodeId, null);
      return null;
    }

    // Node must be on the current active page!
    if (!isNodeOnCurrentPage(node)) {
      destinationCache.set(nodeId, null);
      return null;
    }

    // 2. Check if node is an element inside an already known screen
    let check = node;
    let depth = 0;
    while (check && check.type !== 'PAGE' && check.type !== 'DOCUMENT' && depth < 30) {
      if (screenMap.has(check.id)) {
        const found = screenMap.get(check.id);
        destinationCache.set(nodeId, found);
        return found;
      }
      check = check.parent;
      depth++;
    }

    // 3. Node is an external screen/overlay not yet in screenMap
    // Find the FIRST enclosing ancestor (or node itself) that is a real screen or overlay!
    let candidate = null;
    let curr = node;
    let pDepth = 0;
    while (curr && curr.type !== 'PAGE' && curr.type !== 'DOCUMENT' && pDepth < 30) {
      if (curr.type === 'SECTION') break;
      if (isRealScreen(curr)) {
        candidate = curr;
        break; // STOP AT FIRST REAL SCREEN! DO NOT WALK UP TO GIANT CONTAINER!
      }
      curr = curr.parent;
      pDepth++;
    }

    destinationCache.set(nodeId, candidate);
    return candidate;
  };
}

// Helper to resolve the exportable screen or overlay frame for any destination node ID
function resolveDestinationFrame(nodeId, allScreens) {
  const resolver = createDestinationResolver(allScreens);
  return resolver(nodeId);
}

// Helper to resolve the top-level screen frame for any node ID (backwards compatibility)
function resolveTopLevelFrame(nodeId, allScreens) {
  return resolveDestinationFrame(nodeId, allScreens);
}

// Send current selection and page stats to UI
function sendStats() {
  const allFrames = findAllScreenFrames(figma.currentPage);
  const selection = (figma.currentPage && figma.currentPage.selection) || [];
  const selected = selection.filter(function(n) {
    return isRealScreen(n);
  });
  figma.ui.postMessage({
    type: 'STATS',
    totalFrames: allFrames.length,
    selectedFrames: selected.length
  });
}

// --- FastPath Licensing & Trial Configuration ---
const FREE_EXPORT_LIMIT = 2;
const SECRET_SALT = "FastPath_Pro_2026_Figma_Secret_Salt_Key!";

function computeLicenseChecksum(body: string): string {
  let hash = 0x811c9dc5;
  const str = body.toUpperCase() + SECRET_SALT;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function getLicensePlanInfo(key: string | null | undefined): { valid: boolean; days: number; label: string; tier: string } | null {
  if (!key || typeof key !== 'string') return null;
  const clean = key.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (clean === 'FPPRO-DEV-MASTER-UNLIMITED') {
    return { valid: true, days: 9999, label: 'Master Dev Unlimited', tier: 'DEV' };
  }
  const parts = clean.split('-');
  if (parts.length !== 5 || parts[0] !== 'FPPRO') return null;
  const body = parts[1] + '-' + parts[2] + '-' + parts[3];
  if (parts[4] !== computeLicenseChecksum(body)) return null;

  const tag = parts[1];
  if (tag === '3M' || tag.startsWith('3M') || tag === '03M') {
    return { valid: true, days: 93, label: '3 Months Pro', tier: '3M' };
  }
  if (tag === '6M' || tag.startsWith('6M') || tag === '06M') {
    return { valid: true, days: 186, label: '6 Months Pro', tier: '6M' };
  }
  if (tag === '1Y' || tag.startsWith('1Y') || tag === '12M') {
    return { valid: true, days: 366, label: '1 Year Pro', tier: '1Y' };
  }
  return { valid: true, days: 31, label: '1 Month Pro', tier: '1M' };
}

function validateLicenseKey(key: string | null | undefined): boolean {
  return Boolean(getLicensePlanInfo(key));
}

async function getLicenseState() {
  let licenseKey = null;
  let exportCount = 0;
  let proExpiresAt = 0;
  try {
    licenseKey = await figma.clientStorage.getAsync('fastpath_license_key');
    const storedCount = await figma.clientStorage.getAsync('fastpath_export_count');
    exportCount = typeof storedCount === 'number' ? storedCount : (parseInt(storedCount, 10) || 0);
    const storedExpires = await figma.clientStorage.getAsync('fastpath_pro_expires_at');
    proExpiresAt = typeof storedExpires === 'number' ? storedExpires : (parseInt(storedExpires, 10) || 0);
  } catch (e) {
    console.error('Storage access error:', e);
  }

  const isMaster = (licenseKey === 'FPPRO-DEV-MASTER-UNLIMITED');
  const hasValidKey = validateLicenseKey(licenseKey);
  const now = Date.now();
  const isSubscriptionActive = isMaster || (hasValidKey && proExpiresAt > now);
  const daysLeft = isMaster ? 9999 : (isSubscriptionActive ? Math.max(1, Math.ceil((proExpiresAt - now) / (1000 * 60 * 60 * 24))) : 0);
  const isExpired = !isMaster && hasValidKey && (proExpiresAt > 0) && (now >= proExpiresAt);

  return {
    isPro: isSubscriptionActive,
    isMaster: isMaster,
    isExpired: isExpired,
    daysLeft: daysLeft,
    proExpiresAt: proExpiresAt,
    licenseKey: isSubscriptionActive ? licenseKey : null,
    exportCount: exportCount,
    freeLimit: FREE_EXPORT_LIMIT
  };
}

async function syncLicenseToUI() {
  try {
    const state = await getLicenseState();
    figma.ui.postMessage({
      type: 'LICENSE_STATUS',
      isPro: state.isPro,
      isMaster: state.isMaster,
      isExpired: state.isExpired,
      daysLeft: state.daysLeft,
      proExpiresAt: state.proExpiresAt,
      exportCount: state.exportCount,
      freeLimit: state.freeLimit
    });
  } catch (e) {
    console.error('syncLicenseToUI error:', e);
  }
}

sendStats();
syncLicenseToUI();

figma.on('selectionchange', () => {
  sendStats();
});

function getFramesToExport(scope) {
  const allPageFrames = findAllScreenFrames(figma.currentPage);
  let baseFrames = allPageFrames;

  if (scope === 'SELECTED') {
    const selection = (figma.currentPage && figma.currentPage.selection) || [];
    const selected = selection.filter(function(n) {
      return isRealScreen(n);
    });
    if (selected.length > 0) {
      baseFrames = [];
      for (const s of selected) {
        if (isRealScreen(s)) {
          baseFrames.push(s);
        } else if (s.type === 'SECTION' || s.type === 'GROUP') {
          const secScreens = findAllScreenFrames(s);
          for (const ss of secScreens) {
            baseFrames.push(ss);
          }
        }
      }
    }
  }

  const frameMap = new Map();
  const queue = [];

  for (const f of baseFrames) {
    if (!frameMap.has(f.id)) {
      frameMap.set(f.id, f);
      queue.push(f);
    }
  }

  const resolveDest = createDestinationResolver(allPageFrames);
  const scannedNodeIds = new Set();

  function scanNodeReactionsFast(node) {
    if (!node || scannedNodeIds.has(node.id)) return;
    scannedNodeIds.add(node.id);

    try {
      if ('reactions' in node && Array.isArray(node.reactions)) {
        for (const reaction of node.reactions) {
          if (!reaction) continue;
          const actions = reaction.actions || (reaction.action ? [reaction.action] : []);
          for (const act of actions) {
            if (!act) continue;

            // CRITICAL: Ignore component variant actions and non-navigation actions
            if (act.navigation === 'CHANGE_TO' || act.type === 'CHANGE_TO' ||
                act.type === 'SET_VARIABLE' || act.type === 'SET_VARIABLE_MODE' ||
                act.type === 'CONDITIONAL') {
              continue;
            }

            const isOverlay = act.navigation === 'OVERLAY' ||
              act.navigation === 'OPEN_OVERLAY' ||
              act.navigation === 'SWAP_OVERLAY' ||
              act.type === 'OVERLAY' ||
              act.type === 'OPEN_OVERLAY';
            const isScroll = act.navigation === 'SCROLL_TO' ||
              act.type === 'SCROLL_TO';
            const destId = act.destinationId || act.destinationNodeId || act.destination;

            if (destId) {
              if (isScroll) {
                continue;
              }
              const destFrame = resolveDest(destId);
              if (destFrame && destFrame.id && isRealScreen(destFrame)) {
                if (isOverlay) {
                  const meta = getFrameMeta(destFrame.id);
                  meta.isOverlay = true;
                  meta.overlayPosition = (destFrame as any).overlayPositionType || act.overlayPositionType || (act.overlayRelativePosition ? 'MANUAL' : 'CENTER');
                  meta.closeOnClickOutside = (destFrame as any).overlayBackgroundInteraction !== undefined
                    ? (destFrame as any).overlayBackgroundInteraction !== 'NONE'
                    : (act.overlayBackgroundInteraction !== undefined ? act.overlayBackgroundInteraction !== 'NONE' : true);
                  if ((destFrame as any).overlayBackground) {
                    const rawBg = (destFrame as any).overlayBackground;
                    if (rawBg && rawBg.type === 'SOLID_COLOR' && rawBg.color) {
                      const r = Math.round(rawBg.color.r * 255);
                      const g = Math.round(rawBg.color.g * 255);
                      const b = Math.round(rawBg.color.b * 255);
                      const a = typeof rawBg.color.a === 'number' ? rawBg.color.a : 1;
                      meta.overlayBackground = `rgba(${r}, ${g}, ${b}, ${a})`;
                    } else if (rawBg && rawBg.type === 'NONE') {
                      meta.overlayBackground = 'transparent';
                    }
                  }
                }
                if (!frameMap.has(destFrame.id)) {
                  frameMap.set(destFrame.id, destFrame);
                  queue.push(destFrame);
                }
              }
            }
          }
        }
      }
    } catch (err) {}

    try {
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          scanNodeReactionsFast(child);
        }
      }
    } catch (err) {}
  }

  let processedCount = 0;
  const MAX_BFS_FRAMES = 100; // Safeguard against runaway discovery
  while (queue.length > 0 && processedCount < MAX_BFS_FRAMES) {
    const currentFrame = queue.shift();
    processedCount++;
    scanNodeReactionsFast(currentFrame);
  }

  return Array.from(frameMap.values());
}

function scanReactions(node, rootFrame, allScreens, hotspots, resolveDest) {
  const resolver = resolveDest || createDestinationResolver(allScreens);

  if ('reactions' in node && Array.isArray(node.reactions) && node.reactions.length > 0) {
    for (const reaction of node.reactions) {
      if (!reaction) continue;

      let trigType = reaction.trigger ? reaction.trigger.type : 'ON_CLICK';
      if (trigType === 'WHILE_HOVERING') trigType = 'ON_HOVER';
      if (trigType === 'WHILE_PRESSING') trigType = 'ON_PRESS';

      // Check After-Delay / Timer auto-transition
      if (trigType === 'AFTER_TIMEOUT' || trigType === 'AFTER_DELAY') {
        const actions = reaction.actions || (reaction.action ? [reaction.action] : []);
        for (const act of actions) {
          if (!act) continue;
          if (act.navigation === 'CHANGE_TO' || act.type === 'CHANGE_TO') continue;
          const dest = act.destinationId || act.destinationNodeId || act.destination;
          if (dest) {
            const topFrame = resolver(dest);
            const targetId = topFrame ? topFrame.id : dest;
            const rootMeta = getFrameMeta(rootFrame.id);
            const timeoutSec = typeof reaction.trigger.timeout === 'number' ? reaction.trigger.timeout : 1.5;
            const isOverlayAction = act.navigation === 'OVERLAY' || act.type === 'OVERLAY';
            rootMeta.autoTransition = {
              target: targetId,
              destinationId: targetId,
              isOverlay: isOverlayAction,
              delayMs: Math.round(timeoutSec * 1000),
              transition: act.transition && act.transition.type ? {
                type: act.transition.type,
                direction: act.transition.direction || undefined,
                durationMs: typeof act.transition.duration === 'number' ? Math.round(act.transition.duration * 1000) : 300,
                easing: act.transition.easing ? (act.transition.easing.type || 'EASE_IN_AND_OUT') : 'EASE_IN_AND_OUT'
              } : { type: 'DISSOLVE', durationMs: 300, easing: 'EASE_IN_AND_OUT' }
            };
          }
        }
        continue;
      }

      // Support all interactive triggers: click, press, drag, hover, keyboard, touch
      const actions = reaction.actions || (reaction.action ? [reaction.action] : []);

      for (const action of actions) {
        if (!action) continue;

        // CRITICAL: Ignore component variant actions and non-navigation actions
        if (action.navigation === 'CHANGE_TO' || action.type === 'CHANGE_TO' ||
            action.type === 'SET_VARIABLE' || action.type === 'SET_VARIABLE_MODE' ||
            action.type === 'CONDITIONAL') {
          continue;
        }

        let targetId = '';
        let actionType = 'NAVIGATE';
        let topFrame = null;
        let scrollY = 0;
        let scrollX = 0;
        let destNode = null;

        const isOverlayAction = action.navigation === 'OVERLAY' ||
          action.navigation === 'OPEN_OVERLAY' ||
          action.type === 'OVERLAY' ||
          action.type === 'OPEN_OVERLAY';

        const isScrollAction = action.navigation === 'SCROLL_TO' ||
          action.type === 'SCROLL_TO';

        const isUrlAction = action.type === 'URL' || action.navigation === 'URL';

        if (action.type === 'BACK') {
          targetId = 'BACK';
          actionType = 'BACK';
        } else if (action.type === 'CLOSE' || action.navigation === 'CLOSE' || action.navigation === 'CLOSE_OVERLAY') {
          targetId = 'CLOSE';
          actionType = 'CLOSE_OVERLAY';
        } else if (isUrlAction) {
          actionType = 'URL';
          targetId = action.url || '#';
        } else if (isScrollAction) {
          actionType = 'SCROLL_TO';
          const dest = action.destinationId || action.destinationNodeId || action.destination;
          try {
            if (dest && typeof figma !== 'undefined' && figma.getNodeById) {
              destNode = figma.getNodeById(dest);
            }
          } catch (e) {}

          if (!destNode && rootFrame && (rootFrame as any).findOne) {
            try {
              destNode = (rootFrame as any).findOne((n: any) => n.id === dest || (typeof dest === 'string' && n.name === dest));
            } catch (e) {}
          }

          targetId = dest || (destNode ? destNode.id : '');
          if (destNode && destNode.absoluteBoundingBox && rootFrame.absoluteBoundingBox) {
            scrollY = Math.round(destNode.absoluteBoundingBox.y - rootFrame.absoluteBoundingBox.y);
            scrollX = Math.round(destNode.absoluteBoundingBox.x - rootFrame.absoluteBoundingBox.x);
          }
        } else {
          // Figma Plugin API uses destinationId for NODE actions!
          const dest = action.destinationId || action.destinationNodeId || action.destination;
          if (dest) {
            topFrame = resolver(dest);
            targetId = topFrame ? topFrame.id : dest;
          }

          if (isOverlayAction) {
            actionType = 'OVERLAY';
          } else if (action.navigation === 'SWAP' || action.type === 'SWAP' || action.navigation === 'SWAP_OVERLAY') {
            actionType = 'SWAP';
          } else {
            actionType = 'NAVIGATE';
          }
        }

        if (targetId) {
          const nodeBox = node.absoluteBoundingBox;
          const rootBox = rootFrame.absoluteBoundingBox;

          if (nodeBox && rootBox && rootBox.width > 0 && rootBox.height > 0) {
            const relX = Math.round(nodeBox.x - rootBox.x);
            const relY = Math.round(nodeBox.y - rootBox.y);
            const w = Math.round(nodeBox.width);
            const h = Math.round(nodeBox.height);

            // Constrain percentages between 0% and 100%
            const xPct = Math.max(0, Math.min(100, parseFloat(((relX / rootBox.width) * 100).toFixed(2))));
            const yPct = Math.max(0, Math.min(100, parseFloat(((relY / rootBox.height) * 100).toFixed(2))));
            const wPct = Math.max(0.5, Math.min(100, parseFloat(((w / rootBox.width) * 100).toFixed(2))));
            const hPct = Math.max(0.5, Math.min(100, parseFloat(((h / rootBox.height) * 100).toFixed(2))));

            const hotspotData = {
              id: node.id + '_' + hotspots.length,
              x: relX,
              y: relY,
              width: w,
              height: h,
              xPercent: xPct,
              yPercent: yPct,
              widthPercent: wPct,
              heightPercent: hPct,
              trigger: trigType,
              target: targetId,
              targetName: (destNode && destNode.name) || (topFrame && topFrame.name) || node.name || '',
              action: actionType,
              label: node.name || 'Hotspot'
            };

            if (action.preserveScrollPosition) {
              hotspotData.preserveScrollPosition = true;
            }

            if (reaction.trigger && reaction.trigger.type === 'ON_KEY_DOWN') {
              hotspotData.keyCodes = reaction.trigger.keyCodes ? Array.from(reaction.trigger.keyCodes) : [];
              hotspotData.keyDevice = reaction.trigger.device || 'KEYBOARD';
            }

            if (isUrlAction) {
              hotspotData.url = action.url || '';
              hotspotData.openInNewTab = action.openInNewTab !== false;
            }

            if (actionType === 'SCROLL_TO' || isScrollAction) {
              hotspotData.action = 'SCROLL_TO';
              hotspotData.scrollY = scrollY;
              hotspotData.scrollX = scrollX;
              hotspotData.scrollOffset = action.scrollOffset || action.offset || 0;
            }

            if (action.transition && action.transition.type) {
              hotspotData.transition = {
                type: action.transition.type,
                direction: action.transition.direction || undefined,
                durationMs: typeof action.transition.duration === 'number' ? Math.round(action.transition.duration * 1000) : 300,
                easing: action.transition.easing ? (action.transition.easing.type || 'EASE_IN_AND_OUT') : 'EASE_IN_AND_OUT'
              };
            }

            const topMeta = topFrame ? getFrameMeta(topFrame.id) : null;
            if (actionType === 'OVERLAY' || isOverlayAction || (actionType === 'SWAP' && topMeta && topMeta.isOverlay)) {
              const targetFrame = topFrame || (typeof figma !== 'undefined' && figma.getNodeById ? figma.getNodeById(targetId) : null);
              const targetMeta = targetFrame ? getFrameMeta(targetFrame.id) : null;
              let overlayPosType = action.overlayPositionType ||
                (targetFrame && targetFrame.overlayPositionType) ||
                (targetMeta && targetMeta.overlayPosition) ||
                'CENTER';

              if (action.overlayRelativePosition || action.overlayPositionType === 'MANUAL' || (targetFrame && targetFrame.overlayPositionType === 'MANUAL')) {
                overlayPosType = 'MANUAL';
              }
              hotspotData.overlayPosition = overlayPosType;

              const closeOutside = (targetFrame && targetFrame.overlayBackgroundInteraction !== undefined)
                ? (targetFrame.overlayBackgroundInteraction !== 'NONE')
                : (targetMeta && targetMeta.closeOnClickOutside !== undefined
                  ? targetMeta.closeOnClickOutside
                  : (action.overlayBackgroundInteraction !== undefined ? action.overlayBackgroundInteraction !== 'NONE' : true));
              hotspotData.closeOnClickOutside = closeOutside;

              const rawBg = (targetFrame && targetFrame.overlayBackground) || (targetMeta && targetMeta.overlayBackground);
              if (rawBg && rawBg.type === 'SOLID_COLOR' && rawBg.color) {
                const r = Math.round(rawBg.color.r * 255);
                const g = Math.round(rawBg.color.g * 255);
                const b = Math.round(rawBg.color.b * 255);
                const a = typeof rawBg.color.a === 'number' ? rawBg.color.a : 1;
                hotspotData.overlayBackground = `rgba(${r}, ${g}, ${b}, ${a})`;
              }

              if (action.overlayRelativePosition || overlayPosType === 'MANUAL') {
                const relOffX = action.overlayRelativePosition ? Math.round(action.overlayRelativePosition.x) : 0;
                const relOffY = action.overlayRelativePosition ? Math.round(action.overlayRelativePosition.y) : 0;
                hotspotData.overlayRelativePosition = { x: relOffX, y: relOffY };

                const absOverlayX = relX + relOffX;
                const absOverlayY = relY + relOffY;
                hotspotData.overlayAbsolutePosition = { x: absOverlayX, y: absOverlayY };
                hotspotData.overlayXPercent = parseFloat(((absOverlayX / rootBox.width) * 100).toFixed(2));
                hotspotData.overlayYPercent = parseFloat(((absOverlayY / rootBox.height) * 100).toFixed(2));
              }
            }

            hotspots.push(hotspotData);
          }
        }
      }
    }
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      scanReactions(child, rootFrame, allScreens, hotspots, resolver);
    }
  }
}

// Timeout helper with explicit clearTimeout to avoid hanging promises
function exportWithTimeout(frame, exportConfig, timeoutMs) {
  return new Promise(function(resolve, reject) {
    let timer = null;
    let finished = false;

    timer = setTimeout(function() {
      finished = true;
      reject(new Error('Export timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    frame.exportAsync(exportConfig).then(function(result) {
      if (!finished) {
        clearTimeout(timer);
        resolve(result);
      }
    }).catch(function(err) {
      if (!finished) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function exportPrototype(options) {
  const licenseState = await getLicenseState();
  if (!licenseState.isPro && licenseState.exportCount >= FREE_EXPORT_LIMIT) {
    figma.notify('Free trial exports used. Please subscribe to FastPath Pro to continue.', { error: true });
    figma.ui.postMessage({
      type: 'PAYWALL_TRIGGERED',
      exportCount: licenseState.exportCount,
      freeLimit: FREE_EXPORT_LIMIT
    });
    return;
  }

  const frames = getFramesToExport(options.scope || 'ALL');

  if (frames.length === 0) {
    figma.notify('No exportable frames found. Please select or create frames.', { error: true });
    figma.ui.postMessage({ type: 'ERROR', message: 'No frames found on the active page.' });
    return;
  }

  let startFrameId = frames[0].id;
  const flowStarts = figma.currentPage.flowStartingPoints || [];
  if (flowStarts.length > 0) {
    const match = frames.find(f => f.id === flowStarts[0].nodeId);
    if (match) startFrameId = match.id;
  } else {
    const firstNonOverlay = frames.find(f => !getFrameMeta(f.id).isOverlay && !f.overlayPositionType);
    if (firstNonOverlay) startFrameId = firstNonOverlay.id;
  }

  const schema = {
    title: figma.root.name || 'Prototype',
    startFrameId: startFrameId,
    isPro: licenseState.isPro,
    screens: {}
  };

  const total = frames.length;
  let totalHotspotsCount = 0;
  const resolveDest = createDestinationResolver(frames);

  // Notify UI immediately that frames are found and render is starting
  figma.ui.postMessage({
    type: 'PROGRESS',
    current: 0,
    total: total,
    frameName: 'Подготовка к рендеру (' + total + ' экранов)...',
    percentage: 3,
    hotspotsFound: 0
  });

  // Detect canonical 1-viewport height across non-overlay frames
  let projectBaseViewportHeight: number | undefined = undefined;
  const standardFrames = frames.filter((f: any) => {
    const meta = getFrameMeta(f.id);
    const isOverlay = f.overlayPositionType !== undefined || (meta && meta.isOverlay === true) || f.height < 400;
    return !isOverlay && (f.height / f.width) <= 2.35;
  });
  if (standardFrames.length > 0) {
    const counts: { [key: number]: number } = {};
    standardFrames.forEach((f: any) => {
      const h = Math.round(f.height);
      counts[h] = (counts[h] || 0) + 1;
    });
    let maxC = 0;
    for (const hStr in counts) {
      if (counts[hStr] > maxC) {
        maxC = counts[hStr];
        projectBaseViewportHeight = Number(hStr);
      }
    }
  }

  for (let i = 0; i < total; i++) {
    const frame = frames[i];
    const progressPct = Math.max(5, Math.round(((i + 1) / total) * 100));

    const hotspots = [];
    scanReactions(frame, frame, frames, hotspots, resolveDest);
    totalHotspotsCount += hotspots.length;

    figma.ui.postMessage({
      type: 'PROGRESS',
      current: i + 1,
      total: total,
      frameName: frame.name || ('Экран ' + (i + 1)),
      percentage: progressPct,
      hotspotsFound: totalHotspotsCount
    });

    // Give UI thread time to paint
    await new Promise(function(resolve) { setTimeout(resolve, 25); });

    let bytes = null;
    const requestedScale = options.scale || 2;
    const targetFormat = options.format || 'JPG';

    // Safe dimension constraints: never exceed 3840px to protect WebGL/GPU
    const maxDim = Math.max(frame.width || 0, frame.height || 0);
    const exportConfig = { format: targetFormat };

    if (maxDim > 3840) {
      if ((frame.height || 0) >= (frame.width || 0)) {
        exportConfig.constraint = { type: 'HEIGHT', value: 3840 };
      } else {
        exportConfig.constraint = { type: 'WIDTH', value: 3840 };
      }
    } else {
      let effectiveScale = requestedScale;
      if (maxDim * requestedScale > 3840) {
        effectiveScale = 1;
      }
      exportConfig.constraint = { type: 'SCALE', value: effectiveScale };
    }

    try {
      bytes = await exportWithTimeout(frame, exportConfig, 4000);
    } catch (exportErr) {
      console.warn('Frame export timed out or failed for ' + frame.name + ', trying scale 1x fallback...');
      if (exportConfig.constraint && (exportConfig.constraint.value > 1 || exportConfig.constraint.type !== 'SCALE')) {
        try {
          bytes = await exportWithTimeout(frame, { format: 'JPG', constraint: { type: 'SCALE', value: 1 } }, 2000);
        } catch (fbErr) {
          console.error('Frame fallback export failed for ' + frame.name, fbErr);
        }
      }
    }

    if (!bytes) {
      // 1x1 dummy JPEG fallback so prototype remains interactive
      bytes = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 219, 0, 67, 0, 8, 6, 6, 7, 6, 5, 8, 7, 7, 7, 9, 9, 8, 10, 12, 20, 13, 12, 11, 11, 12, 25, 18, 19, 15, 20, 29, 26, 31, 30, 29, 26, 28, 28, 32, 36, 46, 39, 32, 34, 44, 35, 28, 28, 40, 55, 41, 44, 48, 49, 52, 52, 52, 31, 39, 57, 61, 56, 50, 60, 46, 51, 52, 50, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 191, 255, 217]);
    }

    const cleanId = frame.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ext = (options.format || 'JPG').toLowerCase();
    const imagePath = 'images/' + cleanId + '.' + ext;
    const meta = getFrameMeta(frame.id);
    const frameNameLower = (frame.name && typeof frame.name === 'string') ? frame.name.toLowerCase() : '';
    const isOverlayFrame = Boolean(
      meta.isOverlay ||
      (frame.height <= 550 && (
        frameNameLower.includes('overlay') ||
        frameNameLower.includes('оверлей') ||
        frameNameLower.includes('sheet') ||
        frameNameLower.includes('popup') ||
        frameNameLower.includes('попап') ||
        frameNameLower.includes('шторка') ||
        frameNameLower.includes('модал') ||
        frameNameLower.includes('диалог') ||
        frameNameLower.includes('dialog')
      ))
    );

    const isLongScroll = !isOverlayFrame && (
      (frame.overflowDirection === 'VERTICAL' || frame.overflowDirection === 'BOTH') ||
      (frame.height > frame.width * 1.7) ||
      (frame.width <= 500 && frame.height > 850)
    );
    const viewportH = isLongScroll ? (projectBaseViewportHeight || Math.round(frame.width * (844 / 390))) : Math.round(frame.height);

    let overlayBgStr = undefined;
    const rawBg = frame.overlayBackground || meta.overlayBackground;
    if (rawBg && rawBg.type === 'SOLID_COLOR' && rawBg.color) {
      const r = Math.round(rawBg.color.r * 255);
      const g = Math.round(rawBg.color.g * 255);
      const b = Math.round(rawBg.color.b * 255);
      const a = typeof rawBg.color.a === 'number' ? rawBg.color.a : 1;
      overlayBgStr = `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    const screenRecord = {
      id: frame.id,
      name: frame.name || ('Screen ' + (i + 1)),
      image: imagePath,
      width: Math.round(frame.width),
      height: Math.round(frame.height),
      isOverlay: isOverlayFrame,
      overlayPosition: frame.overlayPositionType || meta.overlayPosition || (isOverlayFrame ? 'CENTER' : undefined),
      closeOnClickOutside: frame.overlayBackgroundInteraction !== undefined
        ? frame.overlayBackgroundInteraction !== 'NONE'
        : (meta.closeOnClickOutside !== undefined ? meta.closeOnClickOutside : true),
      overlayBackground: overlayBgStr,
      viewportHeight: isLongScroll ? viewportH : undefined,
      overflowDirection: frame.overflowDirection || (isLongScroll ? 'VERTICAL' : 'NONE'),
      hotspots: hotspots,
      autoTransition: meta.autoTransition || undefined
    };

    schema.screens[frame.id] = screenRecord;
    if (cleanId !== frame.id) {
      schema.screens[cleanId] = screenRecord;
    }

    // Stream frame to UI immediately (lightweight IPC)
    figma.ui.postMessage({
      type: 'FRAME_EXPORTED',
      id: frame.id,
      cleanId: cleanId,
      screenRecord: screenRecord,
      bytes: bytes,
      format: options.format || 'JPG',
      current: i + 1,
      total: total,
      frameName: frame.name || ('Screen ' + (i + 1)),
      percentage: progressPct,
      hotspotsFound: totalHotspotsCount
    });

    await new Promise(function(resolve) { setTimeout(resolve, 15); });
  }

  // Final export ready message - does NOT need to resend massive images array
  figma.ui.postMessage({
    type: 'EXPORT_READY',
    schema: schema,
    format: options.format || 'JPG',
    totalHotspots: totalHotspotsCount
  });

  if (!licenseState.isPro) {
    const newCount = licenseState.exportCount + 1;
    await figma.clientStorage.setAsync('fastpath_export_count', newCount);
    await syncLicenseToUI();
  }

  figma.notify('Exported ' + frames.length + ' screens (' + totalHotspotsCount + ' hotspots)!');
}

figma.ui.onmessage = async (msg: any) => {
  try {
    if (msg.type === 'START_EXPORT') {
      await exportPrototype({
        scope: msg.scope || 'ALL',
        format: msg.format || 'JPG',
        scale: msg.scale || 2
      });
    } else if (msg.type === 'GET_LICENSE_STATUS') {
      await syncLicenseToUI();
    } else if (msg.type === 'ACTIVATE_LICENSE') {
      const key = (msg.key || '').trim().toUpperCase();
      const plan = getLicensePlanInfo(key);
      if (plan && plan.valid) {
        await figma.clientStorage.setAsync('fastpath_license_key', key);
        const now = Date.now();
        const currentExpires = (await figma.clientStorage.getAsync('fastpath_pro_expires_at')) || 0;
        const baseTime = (typeof currentExpires === 'number' && currentExpires > now) ? currentExpires : now;
        const addMs = plan.days * 24 * 60 * 60 * 1000;
        const newExpires = baseTime + addMs;
        await figma.clientStorage.setAsync('fastpath_pro_expires_at', newExpires);
        figma.notify('FastPath Pro (' + plan.label + ') activated! +' + plan.days + ' days 🎉');
        await syncLicenseToUI();
      } else {
        figma.ui.postMessage({
          type: 'LICENSE_ERROR',
          message: 'Invalid license key. Please check your key and try again.'
        });
      }
    } else if (msg.type === 'RESET_LICENSE_DEV') {
      await figma.clientStorage.deleteAsync('fastpath_license_key');
      await figma.clientStorage.deleteAsync('fastpath_export_count');
      await figma.clientStorage.deleteAsync('fastpath_pro_expires_at');
      figma.notify('License and counters reset (Developer mode)');
      await syncLicenseToUI();
    } else if (msg.type === 'CLOSE_PLUGIN') {
      figma.closePlugin();
    }
  } catch (globalErr: any) {
    console.error('FastPath export error:', globalErr);
    figma.notify('Export error: ' + (globalErr && globalErr.message ? globalErr.message : globalErr), { error: true });
    figma.ui.postMessage({
      type: 'ERROR',
      message: 'Export error: ' + (globalErr && globalErr.message ? globalErr.message : globalErr)
    });
  }
};


