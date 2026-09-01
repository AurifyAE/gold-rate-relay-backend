(function () {
  'use strict';

  if (window.__goldRateRelayInitialized) return;
  window.__goldRateRelayInitialized = true;

  var themeConfig = window.GOLD_RATE_CONFIG || {};

  var CONFIG = {
    relayUrl: themeConfig.relayUrl || '',
    socketIoCDN: 'https://cdn.socket.io/4.8.1/socket.io.min.js',
    troyOzToGram: 31.1035,
    usdToAed: 3.674,
    vatRate: 0.05,
    diamondRate: 18000,
    aedToSar: 1.02,
    aedToUsd: 0.2723,
    ratePollInterval: 60000,
    bullionPurity: {
      '999.9': 0.9999,
      '.9999': 0.9999,
      '999.0': 0.999,
      '0.999': 0.999,
      '995.0': 0.995,
      '0.995': 0.995,
      '916.0': 0.916,
      '0.916': 0.916,
      '750.0': 0.75,
      '0.750': 0.75
    },
    djgRetailRates: {
      '24K': 582.25,
      '22K': 539,
      '21K': 517,
      '18K': 443,
      '14K': 345.5
    }
  };

  var ratesTimestamp = null;
  var ratesPollTimer = null;
  var mutationTimer = null;
  var cartSummaryTimer = null;
  var socketIoPromise = null;
  var relaySocket = null;

  function round2(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  function formatAED(value, decimals) {
    var amount = Number(value || 0);
    var places = typeof decimals === 'number' ? decimals : 0;

    return 'AED ' + amount.toLocaleString('en-AE', {
      minimumFractionDigits: places,
      maximumFractionDigits: places
    });
  }

  function formatAmount(aedAmount, currency, decimals) {
    var code = String(currency || 'AED').toUpperCase();
    var amount = Number(aedAmount || 0);
    var symbol = code;

    if (code === 'SAR') amount *= CONFIG.aedToSar;
    if (code === 'USD') amount *= CONFIG.aedToUsd;

    return symbol + ' ' + amount.toLocaleString('en-AE', {
      minimumFractionDigits: decimals || 0,
      maximumFractionDigits: decimals || 0
    });
  }

  function apiUrl(path) {
    return CONFIG.relayUrl.replace(/\/$/, '') + path;
  }

  function numberOrZero(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function percentageOrNull(value) {
    if (value === undefined || value === null || value === '') return 0;

    var number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100
      ? number
      : null;
  }

  function vatApplies(data) {
    if (data.vatApplicable !== undefined) {
      return data.vatApplicable === true ||
        data.vatApplicable === 'true' ||
        data.vatApplicable === '1';
    }

    return !data.vatExempt;
  }

  function applyCommercialPricing(
    baseCost,
    premiumPercentage,
    businessMarginPercentage,
    vatApplicable
  ) {
    var base = numberOrZero(baseCost);
    var premiumPct = percentageOrNull(premiumPercentage);
    var marginPct = percentageOrNull(businessMarginPercentage);

    if (premiumPct === null || marginPct === null) return null;

    var premium = base * (premiumPct / 100);
    var subtotalAfterPremium = base + premium;
    var businessMargin = base * (marginPct / 100);
    var taxExclusiveSubtotal = subtotalAfterPremium + businessMargin;
    var vat = vatApplicable
      ? taxExclusiveSubtotal * CONFIG.vatRate
      : 0;

    return {
      total: round2(taxExclusiveSubtotal + vat),
      taxExclusiveSubtotal: round2(taxExclusiveSubtotal),
      premiumPercentage: premiumPct,
      premium: round2(premium),
      businessMarginPercentage: marginPct,
      businessMargin: round2(businessMargin),
      vatApplicable: vatApplicable,
      vat: round2(vat)
    };
  }

  function getKaratRate(karat) {
    var requested = String(karat || '22K').toUpperCase();
    var configuredRate = Number(CONFIG.djgRetailRates[requested]);

    if (Number.isFinite(configuredRate)) return configuredRate;

    var numericKarat = parseFloat(requested);
    var rate24k = Number(CONFIG.djgRetailRates['24K'] || 0);

    if (numericKarat > 0 && rate24k > 0) {
      return rate24k * (numericKarat / 24);
    }

    return 0;
  }

  function calculateJewellery(data) {
    var grams = numberOrZero(data.goldGrams);
    var karatRate = getKaratRate(data.karat);
    var diamondCt = numberOrZero(data.diamond);
    var stoneCost = numberOrZero(data.stone);
    var makingPct = numberOrZero(data.making || 12);

    var goldCost = grams * karatRate;
    var diamondCost = diamondCt * CONFIG.diamondRate;
    var makingBase = data.makingOnTotal
      ? goldCost + diamondCost + stoneCost
      : goldCost;
    var making = makingBase * (makingPct / 100);
    var subtotal = goldCost + diamondCost + stoneCost + making;
    var vatBase = data.vatOnAll ? subtotal : goldCost + making;
    var commercial = applyCommercialPricing(
      subtotal,
      data.premiumPercentage,
      data.businessMarginPercentage,
      false
    );

    if (!commercial) return null;

    vatBase += commercial.premium + commercial.businessMargin;
    if (!vatApplies(data)) vatBase = 0;

    var vat = vatBase * CONFIG.vatRate;

    return {
      total: Math.round(
        subtotal + commercial.premium + commercial.businessMargin + vat
      ),
      taxExclusiveSubtotal: round2(
        subtotal + commercial.premium + commercial.businessMargin
      ),
      goldCost: Math.round(goldCost),
      diamCost: Math.round(diamondCost),
      stoneCost: Math.round(stoneCost),
      making: Math.round(making),
      premiumPercentage: commercial.premiumPercentage,
      premium: commercial.premium,
      businessMarginPercentage: commercial.businessMarginPercentage,
      businessMargin: commercial.businessMargin,
      vatApplicable: vatApplies(data),
      vat: Math.round(vat),
      rateKarat: round2(karatRate)
    };
  }

  function calculateBullion(offerUsd, grams, purity, pricing) {
    var offer = Number(offerUsd || 0);
    var weight = Number(grams || 0);
    var fineness = CONFIG.bullionPurity[String(purity || '999.9')];

    if (!offer || !weight || !fineness) return null;

    var rate24kAed = offer / CONFIG.troyOzToGram * CONFIG.usdToAed;
    var ratePerGram = rate24kAed * fineness;
    var goldCost = weight * ratePerGram;
    var commercial = applyCommercialPricing(
      goldCost,
      pricing && pricing.premiumPercentage,
      pricing && pricing.businessMarginPercentage,
      vatApplies(pricing || {})
    );

    if (!commercial) return null;

    return {
      total: commercial.total,
      taxExclusiveSubtotal: commercial.taxExclusiveSubtotal,
      goldCost: round2(goldCost),
      premiumPercentage: commercial.premiumPercentage,
      premium: commercial.premium,
      businessMarginPercentage: commercial.businessMarginPercentage,
      businessMargin: commercial.businessMargin,
      vatApplicable: commercial.vatApplicable,
      vat: commercial.vat,
      ratePerGram: round2(ratePerGram)
    };
  }

  function calculateSilver(offerUsd, grams, pricing) {
    var offer = Number(offerUsd || 0);
    var weight = Number(grams || 0);

    if (!offer || !weight) return null;

    var ratePerGram = offer / CONFIG.troyOzToGram * CONFIG.usdToAed;
    var silverCost = weight * ratePerGram;
    var commercial = applyCommercialPricing(
      silverCost,
      pricing && pricing.premiumPercentage,
      pricing && pricing.businessMarginPercentage,
      vatApplies(pricing || {})
    );

    if (!commercial) return null;

    return {
      total: commercial.total,
      taxExclusiveSubtotal: commercial.taxExclusiveSubtotal,
      silverCost: round2(silverCost),
      premiumPercentage: commercial.premiumPercentage,
      premium: commercial.premium,
      businessMarginPercentage: commercial.businessMarginPercentage,
      businessMargin: commercial.businessMargin,
      vatApplicable: commercial.vatApplicable,
      vat: commercial.vat,
      ratePerGram: round2(ratePerGram)
    };
  }

  window.GoldRate = {
    rate: null,
    bid: null,
    offer: null,
    silverRate: null,
    marketStatus: null,
    timestamp: null,
    isReady: false,
    _currentSilverUsd: null,

    onReady: function (callback) {
      if (this.isReady) {
        callback(this.rate);
        return;
      }

      document.addEventListener('goldrate:updated', function handler(event) {
        callback(event.detail.rate);
        document.removeEventListener('goldrate:updated', handler);
      });
    },

    format: function (amount, currency, decimals) {
      return formatAmount(amount, currency, decimals);
    },

    formatGram: function (karat, currency) {
      var rate = CONFIG.djgRetailRates[karat];

      if (!rate) {
        rate = CONFIG.djgRetailRates['24K'] *
          ((parseFloat(karat) || 18) / 24);
      }

      return formatAmount(Math.round(rate), currency, 0) + '/g';
    },

    calculateBullion: function (data) {
      return calculateBullion(
        this.offer,
        data.goldGrams,
        data.purity,
        data
      );
    },

    calculateSilver: function (data) {
      return Promise.resolve(calculateSilver(
        this._currentSilverUsd,
        data.silverGrams,
        data
      ));
    }
  };

  function dispatchMarketUpdate() {
    document.dispatchEvent(new CustomEvent('goldrate:updated', {
      detail: {
        rate: window.GoldRate.rate,
        bid: window.GoldRate.bid,
        offer: window.GoldRate.offer,
        status: window.GoldRate.marketStatus,
        closed: window.GoldRate.marketStatus !== 'TRADEABLE',
        timestamp: window.GoldRate.timestamp
      }
    }));
  }

  function setTextIfChanged(element, value) {
    if (element && element.textContent !== value) {
      element.textContent = value;
    }
  }

  function updateLiveCartSummaries() {
    var lineTotals = {};

    document
      .querySelectorAll(
        '.cart-live-price-wrapper[data-cart-line-total="true"]' +
        '[data-live-line-total]'
      )
      .forEach(function (wrapper, index) {
        var total = Number(wrapper.dataset.liveLineTotal);
        var row = wrapper.closest('[id^="CartItem-"]');
        var key = row ? row.id : 'live-cart-line-' + index;

        if (Number.isFinite(total) && lineTotals[key] === undefined) {
          lineTotals[key] = total;
        }
      });

    var readyLineKeys = Object.keys(lineTotals);
    var currentLiveTotal = readyLineKeys.reduce(function (sum, key) {
      return sum + lineTotals[key];
    }, 0);

    document
      .querySelectorAll('[data-live-cart-summary-data]')
      .forEach(function (summaryData) {
        var expectedLineCount = Number(
          summaryData.dataset.liveCartLineCount || 0
        );

        if (!expectedLineCount || readyLineKeys.length < expectedLineCount) {
          return;
        }

        var shopifyCartTotal =
          numberOrZero(summaryData.dataset.shopifyCartTotalCents) / 100;
        var originalLiveTotal =
          numberOrZero(summaryData.dataset.shopifyLiveLinesTotalCents) / 100;
        var liveEstimatedTotal = Math.max(
          0,
          shopifyCartTotal - originalLiveTotal + currentLiveTotal
        );
        var cartTotals = summaryData.closest('.cart-totals');
        var totalElement = cartTotals &&
          cartTotals.querySelector('[data-cart-subtotal]');

        if (!totalElement) return;

        var formattedTotal = formatAED(liveEstimatedTotal, 2);

        setTextIfChanged(totalElement, formattedTotal);

        if (totalElement.getAttribute('value') !== formattedTotal) {
          totalElement.setAttribute('value', formattedTotal);
        }

        totalElement.dataset.liveRateTotal = 'true';
        totalElement.removeAttribute('data-calculating');
      });
  }

  function scheduleLiveCartSummaryUpdate() {
    clearTimeout(cartSummaryTimer);
    cartSummaryTimer = setTimeout(updateLiveCartSummaries, 0);
  }

  function updateLiveRateBars() {
    var goldRate = window.GoldRate.rate;
    var silverRate = window.GoldRate.silverRate;
    var marketStatus = window.GoldRate.marketStatus;
    var state = 'loading';
    var statusLabel = 'Connecting';

    if (marketStatus === 'TRADEABLE') {
      state = 'live';
      statusLabel = 'Market live';
    } else if (marketStatus === 'DISCONNECTED') {
      state = 'offline';
      statusLabel = 'Reconnecting';
    } else if (marketStatus === 'FALLBACK') {
      state = 'closed';
      statusLabel = 'Indicative rates';
    } else if (marketStatus === 'CLOSED' || marketStatus === 'WEEKEND') {
      state = 'closed';
      statusLabel = 'Market closed';
    }

    document.querySelectorAll('[data-gold-rate-bar]').forEach(function (bar) {
      bar.dataset.state = state;

      setTextIfChanged(
        bar.querySelector('[data-live-market-status]'),
        statusLabel
      );
      setTextIfChanged(
        bar.querySelector('[data-live-gold-rate]'),
        Number.isFinite(goldRate) && goldRate > 0
          ? formatAED(goldRate, 2) + '/g'
          : 'Loading'
      );
      setTextIfChanged(
        bar.querySelector('[data-live-silver-rate]'),
        Number.isFinite(silverRate) && silverRate > 0
          ? formatAED(silverRate, 2) + '/g'
          : 'Loading'
      );
    });
  }

  function handleMarketData(data) {
    if (!data || !data.symbol) return;

    var symbol = String(data.symbol).toUpperCase();

    if (symbol === 'GOLD') {
      window.GoldRate.offer = Number(data.offer || 0);
      window.GoldRate.bid = Number(data.bid || 0);
      window.GoldRate.rate =
        window.GoldRate.offer / CONFIG.troyOzToGram * CONFIG.usdToAed;
      window.GoldRate.marketStatus = data.marketStatus || 'CLOSED';
      window.GoldRate.timestamp = data.timestamp || data.receivedAt;
      window.GoldRate.isReady = true;

      dispatchMarketUpdate();
    }

    if (symbol === 'SILVER') {
      window.GoldRate._currentSilverUsd = Number(data.offer || 0);
      window.GoldRate.silverRate =
        window.GoldRate._currentSilverUsd /
        CONFIG.troyOzToGram * CONFIG.usdToAed;

      if (!window.GoldRate.marketStatus) {
        window.GoldRate.marketStatus = data.marketStatus || 'CLOSED';
      }
    }

    updateLiveRateBars();
    grUpdateCards(symbol);
  }

  function loadSocketIo() {
    if (socketIoPromise) return socketIoPromise;

    socketIoPromise = new Promise(function (resolve, reject) {
      if (window.io) {
        resolve();
        return;
      }

      var script = document.createElement('script');
      script.src = CONFIG.socketIoCDN;
      script.async = true;
      script.onload = resolve;
      script.onerror = function (error) {
        socketIoPromise = null;
        reject(error);
      };
      document.head.appendChild(script);
    });

    return socketIoPromise;
  }

  function connectRelay() {
    if (relaySocket) return;

    if (!CONFIG.relayUrl) {
      console.error('[GoldRate] Missing relayUrl');
      return;
    }

    relaySocket = window.io(CONFIG.relayUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity
    });

    relaySocket.on('connect', function () {
      console.log('[GoldRate] Dedicated relay connected');
    });

    relaySocket.on('market-data', handleMarketData);

    relaySocket.on('market-status', function (data) {
      window.GoldRate.marketStatus = data.status || 'DISCONNECTED';
      dispatchMarketUpdate();
      updateLiveRateBars();
      grUpdateAllCards();
    });

    relaySocket.on('disconnect', function () {
      window.GoldRate.marketStatus = 'DISCONNECTED';
      dispatchMarketUpdate();
      updateLiveRateBars();
      grUpdateAllCards();
    });

    relaySocket.on('connect_error', function (error) {
      console.warn('[GoldRate] Relay connection failed:', error.message);
    });

    window.addEventListener('beforeunload', function () {
      relaySocket.disconnect();
    });
  }

  function ensureRelayConnection() {
    if (relaySocket) return;
    if (!document.querySelector(
      '.live-gold-price-wrapper, [data-gold-rate-bar]'
    )) return;

    loadSocketIo()
      .then(connectRelay)
      .catch(function (error) {
        console.error('[GoldRate] Socket.IO client failed:', error);
      });
  }

  function grApplyToCard(wrapper, result) {
    if (!result || result.total === undefined) return;

    var priceElement = wrapper.querySelector('.live-gold-price');
    var statusElement = wrapper.querySelector('.market-status-label');

    if (priceElement) {
      var isCents =
        wrapper.dataset.bullion === 'true' ||
        wrapper.dataset.silver === 'true';

      var total = Number(result.total);

      if (wrapper.dataset.cartLineTotal === 'true') {
        total *= Math.max(1, numberOrZero(wrapper.dataset.quantity));
        wrapper.dataset.liveLineTotal = String(round2(total));
        scheduleLiveCartSummaryUpdate();
      }

      priceElement.textContent = formatAED(
        total,
        isCents ? 2 : 0
      );

      priceElement.removeAttribute('data-calculating');
    }

    if (statusElement) {
      var status = window.GoldRate.marketStatus;
      var closed =
        status === 'CLOSED' ||
        status === 'WEEKEND' ||
        status === 'FALLBACK' ||
        status === 'DISCONNECTED';

      statusElement.textContent = closed ? String(status || '') : '';
      statusElement.style.display = closed ? 'block' : 'none';
    }
  }

  function renderBullionCard(wrapper) {
    var result = calculateBullion(
      window.GoldRate.offer,
      wrapper.dataset.gold,
      wrapper.dataset.purity || '999.9',
      wrapper.dataset
    );

    grApplyToCard(wrapper, result);
  }

  function renderSilverCard(wrapper) {
    var result = calculateSilver(
      window.GoldRate._currentSilverUsd,
      wrapper.dataset.silverGrams,
      wrapper.dataset
    );

    grApplyToCard(wrapper, result);
  }

  function renderJewelleryCard(wrapper) {
    var result = calculateJewellery({
      goldGrams: wrapper.dataset.gold || 0,
      karat: wrapper.dataset.karat || '22K',
      diamond: wrapper.dataset.diamond || 0,
      stone: wrapper.dataset.stone || 0,
      making: wrapper.dataset.making || 12,
      premiumPercentage: wrapper.dataset.premiumPercentage || 0,
      businessMarginPercentage:
        wrapper.dataset.businessMarginPercentage || 0,
      vatApplicable: wrapper.dataset.vatApplicable,
      vatExempt: wrapper.dataset.vatExempt === 'true',
      makingOnTotal: wrapper.dataset.makingOnTotal === 'true',
      vatOnAll: wrapper.dataset.vatOnAll === 'true'
    });

    grApplyToCard(wrapper, result);
  }

  function grUpdateCards(updateType) {
    document
      .querySelectorAll('.live-gold-price-wrapper')
      .forEach(function (wrapper) {
        var isBullion = wrapper.dataset.bullion === 'true';
        var isSilver = wrapper.dataset.silver === 'true';
        var isJewellery = !isBullion && !isSilver;

        if (updateType === 'GOLD' && !isBullion) return;
        if (updateType === 'SILVER' && !isSilver) return;
        if (updateType === 'RATES' && !isJewellery) return;

        if (isBullion) {
          renderBullionCard(wrapper);
        } else if (isSilver) {
          renderSilverCard(wrapper);
        } else {
          renderJewelleryCard(wrapper);
        }
      });
  }

  function grUpdateAllCards() {
    grUpdateCards();
  }

  function syncRates() {
    fetch(apiUrl('/api/rates'), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Rates request failed');
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.djgRetailRates) return;

        if (data.updatedAt !== ratesTimestamp) {
          ratesTimestamp = data.updatedAt;
          Object.assign(CONFIG.djgRetailRates, data.djgRetailRates);
          grUpdateCards('RATES');
        }
      })
      .catch(function (error) {
        console.warn('[GoldRate] Rates sync failed:', error);
      });
  }

  function hasJewelleryCards() {
    return Array.prototype.some.call(
      document.querySelectorAll('.live-gold-price-wrapper'),
      function (wrapper) {
        return wrapper.dataset.bullion !== 'true' &&
          wrapper.dataset.silver !== 'true';
      }
    );
  }

  function ensureRatePolling() {
    if (ratesPollTimer || !hasJewelleryCards()) return;

    syncRates();

    ratesPollTimer = setInterval(function () {
      if (document.visibilityState !== 'hidden') {
        syncRates();
      }
    }, CONFIG.ratePollInterval);
  }

  function nodeContainsRateConsumer(node) {
    if (!node || node.nodeType !== 1) return false;

    return node.matches('.live-gold-price-wrapper, [data-gold-rate-bar]') ||
      Boolean(node.querySelector(
        '.live-gold-price-wrapper, [data-gold-rate-bar]'
      ));
  }

  function observeDynamicCards() {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        for (var j = 0; j < mutations[i].addedNodes.length; j += 1) {
          if (nodeContainsRateConsumer(mutations[i].addedNodes[j])) {
            clearTimeout(mutationTimer);
            mutationTimer = setTimeout(function () {
              grUpdateAllCards();
              updateLiveRateBars();
              scheduleLiveCartSummaryUpdate();
              ensureRatePolling();
              ensureRelayConnection();
            }, 0);
            return;
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    grUpdateAllCards();
    updateLiveRateBars();
    scheduleLiveCartSummaryUpdate();
    ensureRatePolling();
    ensureRelayConnection();

    ['variant:update', 'theme:variant:update', 'variant:change']
      .forEach(function (eventName) {
        document.addEventListener(eventName, function () {
          setTimeout(function () {
            grUpdateAllCards();
            updateLiveRateBars();
            scheduleLiveCartSummaryUpdate();
            ensureRatePolling();
            ensureRelayConnection();
          }, 0);
        });
      });

    observeDynamicCards();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
