require('dotenv').config()
import { ftx } from 'ccxt'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import {
    BN,
    Wallet,
	calculateMarkPrice,
	calculateEstimatedFundingRate,
	ClearingHouse,
	PythClient,
	initialize,
	Markets,
	PositionDirection,
	convertToNumber,
	MARK_PRICE_PRECISION,
    QUOTE_PRECISION
} from '@drift-labs/sdk'


const sleep = async (ms: number) => {
    return new Promise(r => setTimeout(r, ms))
}


// ---------------------------------------------------------------------------


const connection = new Connection('https://api.mainnet-beta.solana.com', 'processed')
const keypair = Keypair.fromSecretKey(
	Uint8Array.from(JSON.parse(process.env.secretKey))
)
const wallet = new Wallet(keypair)

const sdkConfig = initialize({ env: 'mainnet-beta' })
const clearingHousePublicKey = new PublicKey(sdkConfig.CLEARING_HOUSE_PROGRAM_ID)

const client = new ftx ({
	apiKey: process.env.apiKeyMain,
	secret: process.env.secretMain
})


// ---------------------------------------------------------------------------


const baseAsset = 'SOL'
const symbol = baseAsset + '-PERP'
const lot = 5      // BaseAsset(SOL)
const limit = 60   // max position = lot * limit (SOL) 


// ---------------------------------------------------------------------------


const main = async () => {
    const clearingHouse = ClearingHouse.from(
        connection,
        wallet,
        clearingHousePublicKey
    )
    await clearingHouse.subscribe()
    const pythClient = new PythClient(connection)
    const MarketInfo = Markets.find((market) => market.baseAssetSymbol === baseAsset)

    let count = 0

    // main loop
    while (true) {
        // calculate drift FR
        let marketAccount = clearingHouse.getMarket(MarketInfo.marketIndex)
		let fundingRateDrift = convertToNumber(
			await calculateEstimatedFundingRate(marketAccount, await pythClient.getPriceData(marketAccount.amm.oracle), new BN(1), "interpolated")
		)

        // calculate FTX FR
        let info = await client.fetchFundingRate(symbol)
		let fundingRateFTX = 100 * info.nextFundingRate

        // current FR Diff
        let fundingRateDiff = fundingRateDrift - fundingRateFTX
        console.log(`Drift FR: ${fundingRateDrift}%`)
        console.log(`FTX FR  : ${fundingRateFTX}%`)
        console.log(`Diff    : ${fundingRateDiff}%`)

        // calculate drift Mark Price
        let markPrice = calculateMarkPrice(marketAccount)
        let driftMarkPrice = convertToNumber(markPrice, MARK_PRICE_PRECISION)


        // open position
        if (fundingRateDiff > 0.01 && count < limit) {    // drift short, FTX long
            // drift short
            let tx = clearingHouse.openPosition(
                PositionDirection.SHORT,
                new BN(lot * driftMarkPrice).mul(QUOTE_PRECISION),
                MarketInfo.marketIndex
            )
            console.log(tx)

            // FTX long
            await client.createMarketOrder(symbol, 'buy', lot)

            count += 1

        } else if (fundingRateDiff < -0.01 && count > -limit) {    // drift long, FTX short
            // drift long
            let tx = clearingHouse.openPosition(
                PositionDirection.LONG,
                new BN(lot * driftMarkPrice).mul(QUOTE_PRECISION),
                MarketInfo.marketIndex
            )
            console.log(tx)

            // FTX short
            await client.createMarketOrder(symbol, 'sell', lot)

            count -= 1
        }


        // close position
        if (fundingRateDiff < 0 && 0 < count) {
            let tx = clearingHouse.openPosition(
                PositionDirection.LONG,
                new BN(lot * driftMarkPrice).mul(QUOTE_PRECISION),
                MarketInfo.marketIndex
            )
            console.log(tx)

            await client.createMarketOrder(symbol, 'sell', lot)

            count -= 1

        } else if (fundingRateDiff > 0 && count < 0) {
            let tx = clearingHouse.openPosition(
                PositionDirection.SHORT,
                new BN(lot * driftMarkPrice).mul(QUOTE_PRECISION),
                MarketInfo.marketIndex
            )
            console.log(tx)

            await client.createMarketOrder(symbol, 'buy', lot)

            count += 1
        }


        // sleep 1 min
        await sleep(60000)
    }
}


// ---------------------------------------------------------------------------


main()
