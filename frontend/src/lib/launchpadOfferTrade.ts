/** Reviewed native funding of a token-specific Launchpad NFT offer. */
import { queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { formatGnotPrice } from "./launchpadListing"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "./launchpadNft"
import { getLaunchpadMarketOffer, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady } from "./launchpadMarket"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_MARKET_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
const MAX_INT64 = 9223372036854775807n
const MAX_AGE = 90n * 24n * 60n * 60n
export const MAKE_OFFER_GAS_WANTED = 50_000_000
const MAKE_OFFER_STORAGE_CAP = 5_000_000

function qInt(raw: string | null): bigint {
    const match = /^\((0|[1-9]\d*) int64\)$/.exec(raw?.trim() ?? "")
    if (!match) throw new Error("Could not verify market state")
    return BigInt(match[1])
}

export interface OfferReadiness {
    collection: LaunchpadNftCollection
    number: bigint
    buyer: string
    owner: string
    configVersion: bigint
    feeBPS: bigint
    policyReady: boolean
}

export async function readOfferReadiness(rpcUrl: string, collectionID: string, number: bigint, buyer: string): Promise<OfferReadiness> {
    if (!/^C[1-9]\d*$/.test(collectionID) || number < 1n || number > MAX_INT64 || !ADDRESS.test(buyer)) throw new Error("Invalid offer identity")
    const version = qInt(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true))
    if (version < 1n || version > MAX_INT64) throw new Error("Market policy is unavailable")
    const [collection, owner, feeBPS, policyReady] = await Promise.all([
        getLaunchpadNftCollection(rpcUrl, collectionID),
        getLaunchpadMarketTokenOwner(rpcUrl, collectionID, number),
        queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, `GetVersion(${version.toString()}).NFTSecondaryFeeBPS`, true).then(qInt),
        isLaunchpadMarketPolicyReady(rpcUrl, "ugnot"),
    ])
    if (qInt(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true)) !== version) throw new Error("Market policy changed. Refresh before offering.")
    if (collection.mode !== "open" || !collection.tradable || owner === null || owner === buyer) throw new Error("This Open NFT is not available for your offer.")
    if (!ADDRESS.test(owner) || feeBPS > 200n || collection.royalties.some((receiver) => !ADDRESS.test(receiver.account))) throw new Error("Invalid offer terms")
    return { collection, number, buyer, owner, configVersion: version, feeBPS, policyReady }
}

function sameReadiness(a: OfferReadiness, b: OfferReadiness): boolean {
    return a.collection.id === b.collection.id && a.collection.mode === b.collection.mode &&
        a.collection.royaltyBPS === b.collection.royaltyBPS &&
        a.collection.royalties.length === b.collection.royalties.length &&
        a.collection.royalties.every((receiver, index) => receiver.account === b.collection.royalties[index].account && receiver.bps === b.collection.royalties[index].bps) &&
        a.number === b.number && a.buyer === b.buyer && a.owner === b.owner &&
        a.configVersion === b.configVersion && a.feeBPS === b.feeBPS && a.policyReady === b.policyReady
}

export function makeOfferScope(chainId: string, buyer: string, collection: string, number: bigint): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_MARKET_PATH, caller: buyer, operation: `make-offer:${collection}#${number.toString()}` }
}

export function buildMakeNativeOfferMsg(readiness: OfferReadiness, price: bigint, expiresAt: bigint, now: bigint): AminoMsg {
    if (!readiness.policyReady || price < 1n || price > MAX_INT64 ||
        expiresAt <= now || expiresAt > now + MAX_AGE || readiness.feeBPS > 200n || readiness.configVersion < 1n) {
        throw new Error("This NFT is not ready for an offer. Refresh its terms.")
    }
    return { type: "vm/MsgCall", value: { caller: readiness.buyer, send: `${price.toString()}ugnot`,
        pkg_path: LAUNCHPAD_MARKET_PATH, func: "MakeOffer",
        args: [readiness.collection.id, readiness.number.toString(), price.toString(), expiresAt.toString(),
            "ugnot", readiness.configVersion.toString()], max_deposit: `${MAKE_OFFER_STORAGE_CAP}ugnot` } }
}

async function offerCount(rpcUrl: string): Promise<bigint> {
    return qInt(await queryEval(rpcUrl, LAUNCHPAD_MARKET_PATH, "OfferCount()", true))
}

export function makeNativeOfferRequest(input: {
    readiness: OfferReadiness; price: bigint; expiresAt: bigint; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { readiness, price, expiresAt, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildMakeNativeOfferMsg(readiness, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
    const collectionID = readiness.collection.id
    const scope = makeOfferScope(chainId, readiness.buyer, collectionID, readiness.number)
    const label = `Offer on ${collectionID} #${readiness.number.toString()}`
    const protocol = price * readiness.feeBPS / 10_000n
    const royalties = readiness.collection.royalties.map((receiver) => ({ account: receiver.account, amount: price * receiver.bps / 10_000n }))
    const royaltyTotal = royalties.reduce((sum, receiver) => sum + receiver.amount, 0n)
    let baselineCount: bigint | null = null
    return {
        title: "Fund NFT offer", summary: `${formatGnotPrice(price)} is held in market escrow`,
        lines: () => [["Token", `${collectionID} #${readiness.number.toString()}`], ["Current owner", readiness.owner],
            ["Escrow deposit", `${formatGnotPrice(price)} (${price.toLocaleString()} ugnot)`],
            ["Seller receives if accepted", `${(price - protocol - royaltyTotal).toLocaleString()} ugnot`],
            ["DAO fee if accepted", `${protocol.toLocaleString()} ugnot (${readiness.feeBPS.toString()} bps)`],
            ["Creator royalties if accepted", `${royaltyTotal.toLocaleString()} ugnot`],
            ...royalties.map((receiver, index): [string, string] => [`Royalty ${index + 1}`, `${receiver.amount.toLocaleString()} ugnot → ${receiver.account}`]),
            ["Expiry", new Date(Number(expiresAt) * 1000).toISOString()], ["Realm", LAUNCHPAD_MARKET_PATH],
            ["Network", chainId], ["Gas limit", MAKE_OFFER_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${MAKE_OFFER_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["The full offer price leaves your wallet now and remains in market escrow until acceptance, your cancellation, or expiry refund.",
            "The DAO fee rate and creator royalties are pinned now. The DAO treasury recipient is read from policy when the seller accepts."],
        acks: ["I checked the escrow amount, token, payout terms, expiry and chain before opening Adena."],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await readOfferReadiness(rpcUrl, collectionID, readiness.number, readiness.buyer)
            if (!sameReadiness(readiness, fresh)) throw new Error("Token or market terms changed. Refresh before signing.")
            buildMakeNativeOfferMsg(fresh, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
            baselineCount = await offerCount(rpcUrl)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label, { gasWanted: MAKE_OFFER_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            if (baselineCount === null || await offerCount(rpcUrl) !== baselineCount + 1n) return false
            const offer = await getLaunchpadMarketOffer(rpcUrl, `O${(baselineCount + 1n).toString()}`)
            return offer.status === "active" && offer.collection === collectionID && offer.number === readiness.number &&
                offer.buyer === readiness.buyer && offer.price === price && offer.currency === "ugnot" &&
                offer.expiresAt === expiresAt && offer.configVersion === readiness.configVersion &&
                offer.protocolFeeBPS === readiness.feeBPS && offer.royaltyBPS === readiness.collection.royaltyBPS
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}
