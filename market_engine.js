// MARKET ENGINE - Supply/Demand + News Drift Model
// Handles: order flow impact, liquidity scaling, net flow drift, news sentiment, mean reversion

const MarketEngine = {
    // Stock configurations
    stockConfig: {
        ADANIPORTS: { startPrice: 850.00, dailyVolume: 2_500_000, K: 1.05 },
        LT: { startPrice: 3400.00, dailyVolume: 3_200_000, K: 1.00 },
        JSWSTEEL: { startPrice: 820.00, dailyVolume: 8_500_000, K: 0.85 },
        ONGC: { startPrice: 260.00, dailyVolume: 12_800_000, K: 0.75 },
        TCS: { startPrice: 4100.00, dailyVolume: 1_800_000, K: 1.15 },
        TITAN: { startPrice: 3600.00, dailyVolume: 2_800_000, K: 1.05 },
        CEATLTD: { startPrice: 2800.00, dailyVolume: 680_000, K: 1.60 },
        SBIN: { startPrice: 720.00, dailyVolume: 18_500_000, K: 0.70 }
    },

    // News sentiment by session
    newsSentiment: {
        1: {
            ADANIPORTS: 'Mixed', LT: 'Mixed', TITAN: 'Mixed',
            JSWSTEEL: 'Negative Lean', ONGC: 'Mixed', 
            TCS: 'Positive Lean', CEATLTD: 'Negative', SBIN: 'Positive Lean'
        },
        2: {
            ADANIPORTS: 'Negative', LT: 'Mixed', TITAN: 'Positive Lean',
            JSWSTEEL: 'Negative Lean', ONGC: 'Negative Lean',
            TCS: 'Negative', CEATLTD: 'Mixed', SBIN: 'Negative'
        },
        3: {
            ADANIPORTS: 'Negative Lean', LT: 'Negative', TITAN: 'Negative',
            JSWSTEEL: 'Positive Lean', ONGC: 'Negative Lean',
            TCS: 'Negative', CEATLTD: 'Mixed', SBIN: 'Positive Lean'
        }
    },

    // Drift targets per sentiment label per session
    driftTargets: {
        1: { 'Positive Lean': 0.009, 'Mixed': 0.002, 'Negative Lean': -0.007, 'Negative': -0.013 },
        2: { 'Positive Lean': 0.013, 'Mixed': 0.001, 'Negative Lean': -0.011, 'Negative': -0.018 },
        3: { 'Positive Lean': 0.016, 'Mixed': 0.000, 'Negative Lean': -0.014, 'Negative': -0.022 }
    },

    // Parameters
    params: {
        depthFactor: 0.02,
        perTradeImpactClamp: 0.025,
        flowDivisor: 50,
        maxFlowPct: 0.002,
        noiseRangePct: 0.0002,
        driftWindowSeconds: 3600,
        driftHalfLife: 1200, // 20 minutes
        sessionWeights: { 1: 0.15, 2: 0.35, 3: 0.50 }
    },

    // State per stock
    state: {},

    // Active sessions
    activeSessions: [],

    // Session start times (for drift decay)
    sessionStartTimes: {},

    // Update loop interval
    tickInterval: null,

    // Initialize engine
    init() {
        // Initialize state for each stock
        for (const [symbol, config] of Object.entries(this.stockConfig)) {
            this.state[symbol] = {
                price: config.startPrice,
                openPrice: config.startPrice,
                high: config.startPrice,
                low: config.startPrice,
                volumeTraded: 0,
                netFlowValue: 0,
                lastTrades: [],
                priceHistory: [config.startPrice]
            };
        }

        // Start tick loop
        this.startTickLoop();
    },

    // Add transaction (called from UI)
    addTransaction(symbol, side, qty, tradePrice) {
        if (!this.state[symbol]) {
            console.error(`Unknown stock: ${symbol}`);
            return;
        }

        const stock = this.state[symbol];
        const config = this.stockConfig[symbol];

        // Calculate signed value
        const direction = side === 'BUY' ? 1 : -1;
        const tradeValue = qty * tradePrice;
        const signedValue = direction * tradeValue;

        // Calculate liquidity value
        const liquidityValue = (config.dailyVolume * stock.price) * this.params.depthFactor;

        // Calculate immediate price impact
        const impactPct = direction * config.K * Math.sqrt(tradeValue / liquidityValue);
        const clampedImpact = Math.max(-this.params.perTradeImpactClamp, 
                                       Math.min(this.params.perTradeImpactClamp, impactPct));

        // Update price
        stock.price *= (1 + clampedImpact);

        // Update OHLC
        stock.high = Math.max(stock.high, stock.price);
        stock.low = Math.min(stock.low, stock.price);

        // Update volume and net flow
        stock.volumeTraded += qty;
        stock.netFlowValue += signedValue;

        // Record trade
        stock.lastTrades.unshift({
            side,
            qty,
            price: tradePrice,
            timestamp: new Date(),
            resultingPrice: stock.price
        });
        if (stock.lastTrades.length > 10) stock.lastTrades.pop();

        // Add to price history
        stock.priceHistory.push(stock.price);
        if (stock.priceHistory.length > 100) stock.priceHistory.shift();

        console.log(`Trade executed: ${symbol} ${side} ${qty}@${tradePrice.toFixed(2)} → Price: ₹${stock.price.toFixed(2)} (impact: ${(clampedImpact * 100).toFixed(3)}%)`);

        return stock.price;
    },

    // Activate a news session
    activateSession(sessionNum) {
        if (!this.activeSessions.includes(sessionNum)) {
            this.activeSessions.push(sessionNum);
            this.sessionStartTimes[sessionNum] = Date.now();
            console.log(`Session ${sessionNum} activated`);
        }
    },

    // Calculate total drift bias for a stock
    calculateDriftBias(symbol) {
        let totalDrift = 0;
        const now = Date.now();

        for (const session of this.activeSessions) {
            const sentiment = this.newsSentiment[session][symbol];
            const baseDrift = this.driftTargets[session][sentiment];
            const weight = this.params.sessionWeights[session];

            // Apply drift decay (exponential)
            const sessionAge = (now - this.sessionStartTimes[session]) / 1000; // seconds
            const decayFactor = Math.exp(-Math.log(2) * sessionAge / this.params.driftHalfLife);

            // Per-second drift
            const driftPerSecond = (baseDrift / this.params.driftWindowSeconds) * decayFactor;

            totalDrift += weight * driftPerSecond;
        }

        return totalDrift;
    },

    // Apply mean reversion adjustment
    applyMeanReversion(symbol, drift) {
        const stock = this.state[symbol];
        const dayChangePct = (stock.price - stock.openPrice) / stock.openPrice;

        // If down >2%, reduce negative drift by 60% (dip buyers)
        if (dayChangePct < -0.02 && drift < 0) {
            return drift * 0.4;
        }

        return drift;
    },

    // Tick update (called every second)
    tick() {
        for (const [symbol, stock] of Object.entries(this.state)) {
            const config = this.stockConfig[symbol];
            let priceChange = 0;

            // 1. Net flow drift
            const liquidityValue = (config.dailyVolume * stock.price) * this.params.depthFactor;
            const flowImpact = stock.netFlowValue / (liquidityValue * this.params.flowDivisor);
            const clampedFlow = Math.max(-this.params.maxFlowPct, 
                                         Math.min(this.params.maxFlowPct, flowImpact));
            priceChange += clampedFlow;

            // 2. News drift
            let newsDrift = this.calculateDriftBias(symbol);
            newsDrift = this.applyMeanReversion(symbol, newsDrift);
            priceChange += newsDrift;

            // 3. Random noise
            const noise = (Math.random() - 0.5) * 2 * this.params.noiseRangePct;
            priceChange += noise;

            // Apply total change
            stock.price *= (1 + priceChange);

            // Update OHLC
            stock.high = Math.max(stock.high, stock.price);
            stock.low = Math.min(stock.low, stock.price);

            // Update price history
            stock.priceHistory.push(stock.price);
            if (stock.priceHistory.length > 100) stock.priceHistory.shift();
        }
    },

    // Start tick loop
    startTickLoop() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        this.tickInterval = setInterval(() => this.tick(), 1000);
    },

    // Stop tick loop
    stopTickLoop() {
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
    },

    // Get current state for a stock
    getState(symbol) {
        return this.state[symbol];
    },

    // Export transaction log
    exportTransactions() {
        const log = [];
        for (const [symbol, stock] of Object.entries(this.state)) {
            stock.lastTrades.forEach(trade => {
                log.push({
                    symbol,
                    ...trade
                });
            });
        }
        return log.sort((a, b) => b.timestamp - a.timestamp);
    },

    // Reset for new session
    reset() {
        this.stopTickLoop();
        this.activeSessions = [];
        this.sessionStartTimes = {};
        
        for (const [symbol, config] of Object.entries(this.stockConfig)) {
            this.state[symbol] = {
                price: config.startPrice,
                openPrice: config.startPrice,
                high: config.startPrice,
                low: config.startPrice,
                volumeTraded: 0,
                netFlowValue: 0,
                lastTrades: [],
                priceHistory: [config.startPrice]
            };
        }
        
        this.startTickLoop();
    }
};

// Export for use in HTML
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MarketEngine;
}
