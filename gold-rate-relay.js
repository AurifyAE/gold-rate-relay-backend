(function () {
  'use strict';

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
    cardFetchDebounce: 250,
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

  var cardTimers = {};
  var cardKeySequence = 0;
  var ratesTimestamp = null;
  var ratesPollTimer = null;
  var mutationTimer = null;

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

  function apiUrl(path, params) {
    var url = CONFIG.relayUrl.replace(/\/$/, '') + path;

    if (!params) return url;

    var query = Object.keys(params)
      .filter(function (key) {
        return params[key] !== undefined && params[key] !== null;
      })
      .map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      })
      .join('&');

    return query ? url + '?' + query : url;
  }

  function calculateBullion(offerUsd, grams, purity, vatExempt) {
    var offer = Number(offerUsd || 0);
    var weight = Number(grams || 0);
    var fineness = CONFIG.bullionPurity[String(purity || '999.9')];

    if (!offer || !weight || !fineness) return null;

    var rate24kAed = offer / CONFIG.troyOzToGram * CONFIG.usdToAed;
    var ratePerGram = rate24kAed * fineness;
    var goldCost = weight * ratePerGram;
    var vat = vatExempt ? 0 : goldCost * CONFIG.vatRate;

    return {
      total: round2(goldCost + vat),
      goldCost: round2(goldCost),
      vat: round2(vat),
      ratePerGram: round2(ratePerGram)
    };
  }

  function calculateSilver(offerUsd, grams, vatExempt) {
    var offer = Number(offerUsd || 0);
    var weight = Number(grams || 0);

    if (!offer || !weight) return null;

    var ratePerGram = offer / CONFIG.troyOzToGram * CONFIG.usdToAed;
    var silverCost = weight * ratePerGram;
    var vat = vatExempt ? 0 : silverCost * CONFIG.vatRate;

    return {
      total: round2(silverCost + vat),
      silverCost: round2(silverCost),
      vat: round2(vat),
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
        Boolean(data.vatExempt)
      );
    },

    calculateSilver: function (data) {
      return Promise.resolve(calculateSilver(
        this._currentSilverUsd,
        data.silverGrams,
        Boolean(data.vatExempt)
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

    grUpdateAllCards();
  }

  function loadSocketIo() {
    return new Promise(function (resolve, reject) {
      if (window.io) {
        resolve();
        return;
      }

      var script = document.createElement('script');
      script.src = CONFIG.socketIoCDN;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function connectRelay() {
    if (!CONFIG.relayUrl) {
      console.error('[GoldRate] Missing relayUrl');
      return;
    }

    var socket = window.io(CONFIG.relayUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', function () {
      console.log('[GoldRate] Dedicated relay connected');
    });

    socket.on('market-data', handleMarketData);

    socket.on('market-status', function (data) {
      window.GoldRate.marketStatus = data.status || 'DISCONNECTED';
      dispatchMarketUpdate();
    });

    socket.on('disconnect', function () {
      window.GoldRate.marketStatus = 'DISCONNECTED';
      dispatchMarketUpdate();
    });

    socket.on('connect_error', function (error) {
      console.warn('[GoldRate] Relay connection failed:', error.message);
    });

    window.addEventListener('beforeunload', function () {
      socket.disconnect();
    });
  }

  function grCardKey(wrapper) {
    if (!wrapper.dataset.grKey) {
      cardKeySequence += 1;
      wrapper.dataset.grKey = 'gold-rate-' + cardKeySequence;
    }

    return wrapper.dataset.grKey;
  }

  function grApplyToCard(wrapper, result) {
    if (!result || result.total === undefined) return;

    var priceElement = wrapper.querySelector('.live-gold-price');
    var statusElement = wrapper.querySelector('.market-status-label');

    if (priceElement) {
      var isCents =
        wrapper.dataset.bullion === 'true' ||
        wrapper.dataset.silver === 'true';

      priceElement.textContent = formatAED(
        result.total,
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
      wrapper.dataset.vatExempt === 'true'
    );

    grApplyToCard(wrapper, result);
  }

  function renderSilverCard(wrapper) {
    var result = calculateSilver(
      window.GoldRate._currentSilverUsd,
      wrapper.dataset.silverGrams,
      wrapper.dataset.vatExempt === 'true'
    );

    grApplyToCard(wrapper, result);
  }

  function fetchJewelleryPrice(wrapper) {
    var key = grCardKey(wrapper);
    clearTimeout(cardTimers[key]);

    cardTimers[key] = setTimeout(function () {
      fetch(apiUrl('/api/price', {
        grams: wrapper.dataset.gold || 0,
        karat: wrapper.dataset.karat || '22K',
        diamond: wrapper.dataset.diamond || 0,
        stone: wrapper.dataset.stone || 0,
        making: wrapper.dataset.making || 12,
        vatExempt: wrapper.dataset.vatExempt === 'true' ? 1 : 0,
        makingOnTotal:
          wrapper.dataset.makingOnTotal === 'true' ? 1 : 0,
        vatOnAll: wrapper.dataset.vatOnAll === 'true' ? 1 : 0
      }), { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('Price request failed');
          return response.json();
        })
        .then(function (result) {
          grApplyToCard(wrapper, result);
        })
        .catch(function (error) {
          console.warn('[GoldRate] Jewellery price failed:', error);
        });
    }, CONFIG.cardFetchDebounce);
  }

  function grUpdateAllCards() {
    document
      .querySelectorAll('.live-gold-price-wrapper')
      .forEach(function (wrapper) {
        if (wrapper.dataset.bullion === 'true') {
          renderBullionCard(wrapper);
        } else if (wrapper.dataset.silver === 'true') {
          renderSilverCard(wrapper);
        } else {
          fetchJewelleryPrice(wrapper);
        }
      });
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
          grUpdateAllCards();
        }
      })
      .catch(function (error) {
        console.warn('[GoldRate] Rates sync failed:', error);
      });
  }

  function startRatePolling() {
    syncRates();

    ratesPollTimer = setInterval(function () {
      if (document.visibilityState !== 'hidden') {
        syncRates();
      }
    }, CONFIG.ratePollInterval);
  }

  function observeDynamicCards() {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        if (mutations[i].addedNodes.length) {
          clearTimeout(mutationTimer);
          mutationTimer = setTimeout(grUpdateAllCards, 0);
          return;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    startRatePolling();
    grUpdateAllCards();

    ['variant:update', 'theme:variant:update', 'variant:change']
      .forEach(function (eventName) {
        document.addEventListener(eventName, function () {
          setTimeout(grUpdateAllCards, 0);
        });
      });

    observeDynamicCards();

    loadSocketIo()
      .then(connectRelay)
      .catch(function (error) {
        console.error('[GoldRate] Socket.IO client failed:', error);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
