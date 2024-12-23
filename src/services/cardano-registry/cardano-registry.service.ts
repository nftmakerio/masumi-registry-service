import { $Enums } from "@prisma/client";
import { Sema } from "async-sema";
import { prisma } from '@/utils/db';
import { z } from "zod";
import { metadataStringConvert } from "@/utils/metadata-string-convert";
import { healthCheckService } from "@/services/health-check";
import { logger } from "@/utils/logger";
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";

const metadataSchema = z.object({

    /*
"name": "<name>",
"description": "<description>",
"api_url": "<api_url>",
"example_output": "<ipfs_hash>",
"version": "<version>",
"author": {
"name": "<author_name>",
"contact": "<author_contact_details>",
"organization": "<author_orga>"
},
"payment_address": "<cardano_address>",
"requests_per_hour": "request_amount",
"tags": [
"<tag>"
],
"legal": {
"privacy policy": "<url>",
"terms": "<url>",
"other": "<url>"
},
"image": "http://example.com/path/to/image.png"
    */
    name: z.string(),
    description: z.string().or(z.array(z.string())).optional(),
    api_url: z.string().url().or(z.array(z.string())),
    capability_name: z.string().or(z.array(z.string())),
    capability_version: z.string(),
    capability_description: z.string().or(z.array(z.string())).optional(),
    company_name: z.string().or(z.array(z.string())).optional()
})
const deleteMutex = new Sema(1);
export async function updateDeregisteredCardanoRegistryEntries() {
    const sources = await prisma.registrySources.findMany({
        where: {
            type: $Enums.RegistryEntryType.WEB3_CARDANO_V1,
            identifier: { not: null },
        }
    })

    if (sources.length == 0)
        return;

    const acquiredMutex = await deleteMutex.tryAcquire();
    //if we are already performing an update, we wait for it to finish and return
    if (!acquiredMutex)
        return await deleteMutex.acquire();

    await Promise.all(sources.map(async (source) => {
        try {
            const blockfrost = new BlockFrostAPI({
                projectId: source.apiKey!,
                network: source.network == $Enums.Network.MAINNET ? "mainnet" : "preview"
            });
            let cursorId = null;
            let latestAssets = await prisma.registryEntry.findMany({
                where: {
                    status: { in: [$Enums.Status.ONLINE, $Enums.Status.OFFLINE] },
                    registrySourcesId: source.id
                },
                orderBy: { lastUptimeCheck: "desc" },
                take: 50,
                cursor: cursorId != null ? { id: cursorId } : undefined
            })

            while (latestAssets.length != 0) {

                const assetsToProcess = await Promise.all(latestAssets.map(async (asset) => {
                    return await blockfrost.assetsById(asset.identifier)
                }))

                const burnedAssets = assetsToProcess.filter(a => a.quantity == "0")

                await Promise.all(burnedAssets.map(async (asset) => {
                    await prisma.registryEntry.update({
                        where: { identifier_registrySourcesId: { identifier: asset.asset, registrySourcesId: source.id } },
                        data: { status: $Enums.Status.DEREGISTERED }
                    })
                }))

                if (latestAssets.length < 50)
                    break;

                cursorId = latestAssets[latestAssets.length - 1].id
                latestAssets = await prisma.registryEntry.findMany({
                    where: {
                        status: { in: [$Enums.Status.ONLINE, $Enums.Status.OFFLINE] },
                        registrySourcesId: source.id
                    },
                    orderBy: { lastUptimeCheck: "desc" },
                    take: 50,
                    cursor: cursorId != null ? { id: cursorId } : undefined
                })

            }
            if (latestAssets.length == 0)
                return;
        } catch (error) {
            logger.error("Error updating deregistered cardano registry entries", { error: error, sourceId: source.id })
        }
        return null;
    }))
}

const updateMutex = new Sema(1);
export async function updateLatestCardanoRegistryEntries(onlyEntriesAfter?: Date | undefined) {
    logger.info("Updating cardano registry entries after: ", { onlyEntriesAfter: onlyEntriesAfter })
    if (onlyEntriesAfter == undefined)
        return;

    //we do not need any isolation level here as worst case we have a few duplicate checks in the next run but no data loss. Advantage we do not need to lock the table
    const sources = await prisma.registrySources.findMany({
        where: {
            type: $Enums.RegistryEntryType.WEB3_CARDANO_V1,
            identifier: { not: null },
            updatedAt: {
                lte: onlyEntriesAfter
            }
        }
    })

    if (sources.length == 0)
        return;

    const acquiredMutex = await updateMutex.tryAcquire();
    //if we are already performing an update, we wait for it to finish and return
    if (!acquiredMutex)
        return await updateMutex.acquire();

    try {
        //sanity checks
        const invalidSourcesTypes = sources.filter(s => s.type !== $Enums.RegistryEntryType.WEB3_CARDANO_V1)
        if (invalidSourcesTypes.length > 0)
            throw new Error("Invalid source types")
        const invalidSourceIdentifiers = sources.filter(s => s.identifier == null)
        if (invalidSourceIdentifiers.length > 0)
            //this should never happen unless the db is corrupted or someone played with the settings
            throw new Error("Invalid source identifiers")

        logger.debug("updating entries from sources", { count: sources.length })
        //the return variable, note that the order of the entries is not guaranteed
        const latestEntries: ({ name: string; status: $Enums.Status; description: string | null; api_url: string; company_name: string | null; id: string; createdAt: Date; updatedAt: Date; identifier: string; lastUptimeCheck: Date; uptimeCount: number; uptimeCheckCount: number; registrySourcesId: string; capabilitiesId: string; })[] = []
        //iterate via promises to skip await time
        await Promise.all(sources.map(async (source) => {
            try {
                const blockfrost = new BlockFrostAPI({
                    projectId: source.apiKey!,
                    network: source.network == $Enums.Network.MAINNET ? "mainnet" : source.network == $Enums.Network.PREVIEW ? "preview" : "preprod"
                });
                let pageOffset = source.latestPage
                let latestIdentifier = source.latestIdentifier
                let latestAssets = await blockfrost.assetsPolicyById(source.identifier!, { page: pageOffset, count: 100 })
                pageOffset = pageOffset + 1
                while (latestAssets.length != 0) {
                    let assetsToProcess = latestAssets
                    if (latestIdentifier != null) {
                        logger.debug("Latest identifier", { latestIdentifier: latestIdentifier })
                        const foundAsset = latestAssets.findIndex(a => a.asset === latestIdentifier)
                        //sanity check
                        if (foundAsset != -1) {
                            logger.info("found asset", { foundAsset: foundAsset })
                            //check if we have more assets to process
                            if (foundAsset + 1 < latestAssets.length) {
                                assetsToProcess = latestAssets.slice(foundAsset + 1)
                            } else {
                                //we are at the latest asset of the page
                                assetsToProcess = []
                            }
                        } else {
                            logger.info("Latest identifier not found", { latestIdentifier: latestIdentifier })
                        }

                    }

                    const updatedTMP = await updateCardanoAssets(assetsToProcess, source)
                    if (updatedTMP) {
                        latestEntries.push(...updatedTMP)
                    }
                    if (latestAssets.length > 0)
                        latestIdentifier = latestAssets[latestAssets.length - 1].asset

                    if (latestAssets.length < 100) {
                        logger.debug("No more assets to process", { latestIdentifier: latestIdentifier })
                        break;
                    }



                    latestAssets = await blockfrost.assetsPolicyById(source.identifier!, { page: pageOffset, count: 100 })
                    pageOffset = pageOffset + 1
                }
                await prisma.registrySources.update({
                    where: { id: source.id },
                    data: { latestPage: (pageOffset - 1), latestIdentifier: latestIdentifier }
                })

                latestAssets = await blockfrost.assetsPolicyById(source.identifier!, { page: pageOffset, count: 100 })
            } catch (error) {
                logger.error("Error updating cardano registry entries", { error: error, sourceId: source.id })
            }
        }))
    } finally {
        //library is strange as we can release from any non-acquired semaphore
        updateMutex.release()
    }

    //sort by sources creation date and entries creation date
    //probably unnecessary to return the entries and does not work nicely with mutex
    /*return latestEntries.sort((a, b) => {
        if (a.registrySourcesId == b.registrySourcesId)
            return a.createdAt.getTime() - b.createdAt.getTime()
        const sourceA = sources.find(s => s.id == a.registrySourcesId)
        const sourceB = sources.find(s => s.id == b.registrySourcesId)
        if (sourceA && sourceB)
            return sourceA.createdAt.getTime() - sourceB.createdAt.getTime()
        return 0
    })*/
}

export const updateCardanoAssets = async (latestAssets: { asset: string, quantity: string }[], source: { id: string, identifier: string | null, apiKey: string | null, network: $Enums.Network | null }) => {
    logger.info(`updating ${latestAssets.length} cardano assets`)
    //note that the order of the entries is not guaranteed at this point
    const resultingUpdates = await Promise.all(latestAssets.map(async (asset) => {
        if (source.network == null)
            throw new Error("Source network is not set")
        if (source.apiKey == null)
            throw new Error("Source api key is not set")

        logger.debug("updating asset", { asset: asset.asset, quantity: asset.quantity })
        //we will allow only unique tokens (integer quantities) via smart contract, therefore we do not care about large numbers
        const quantity = parseInt(asset.quantity)
        if (quantity == 0) {
            //TOKEN is deregistered we will update the status and return null
            await prisma.registryEntry.upsert({
                where: {
                    identifier_registrySourcesId: {
                        identifier: asset.asset,
                        registrySourcesId: source.id
                    }
                },
                update: { status: $Enums.Status.DEREGISTERED },
                create: {
                    status: $Enums.Status.DEREGISTERED, capability: { connectOrCreate: { create: { name: "", version: "" }, where: { name_version: { name: "", version: "" } } } }, identifier: asset.asset, registry: { connect: { id: source.id } }, name: "", description: "", api_url: "", company_name: "", lastUptimeCheck: new Date()
                }
            })
            return null;
        }

        const blockfrost = new BlockFrostAPI({
            projectId: source.apiKey!,
            network: source.network == $Enums.Network.MAINNET ? "mainnet" : source.network == $Enums.Network.PREVIEW ? "preview" : "preprod"
        });

        const registryData = await blockfrost.assetsById(asset.asset)
        const holderData = await blockfrost.assetsAddresses(asset.asset, { order: "desc" })
        const onchainMetadata = registryData.onchain_metadata
        const parsedMetadata = metadataSchema.safeParse(onchainMetadata)

        //if the metadata is not valid or the token has no holder -> is burned, we skip it
        if (!parsedMetadata.success || holderData.length < 1)
            return null;

        //check endpoint
        const endpoint = metadataStringConvert(parsedMetadata.data.api_url)!
        const isAvailable = await healthCheckService.checkAndVerifyEndpoint({ api_url: endpoint, identifier: asset.asset, registry: { identifier: source.identifier!, type: $Enums.RegistryEntryType.WEB3_CARDANO_V1 } })

        return await prisma.$transaction(async (tx) => {
            const existingEntry = await tx.registryEntry.findUnique({
                where: {
                    identifier_registrySourcesId: {
                        identifier: asset.asset,
                        registrySourcesId: source.id
                    }
                }
            })
            let newEntry;
            if (existingEntry) {
                newEntry = await tx.registryEntry.update({
                    include: {
                        registry: true,
                        paymentIdentifier: true,
                        capability: true
                    },
                    where: {
                        identifier_registrySourcesId: {
                            identifier: asset.asset,
                            registrySourcesId: source.id
                        }
                    },
                    data: {
                        lastUptimeCheck: new Date(),
                        uptimeCount: { increment: isAvailable == $Enums.Status.ONLINE ? 1 : 0 },
                        uptimeCheckCount: { increment: 1 },
                        status: isAvailable,
                        name: parsedMetadata.data.name,
                        description: metadataStringConvert(parsedMetadata.data.description),
                        api_url: metadataStringConvert(parsedMetadata.data.api_url)!,
                        company_name: metadataStringConvert(parsedMetadata.data.company_name),
                        paymentIdentifier: {
                            upsert: {
                                create: {
                                    paymentIdentifier: holderData[0].address,
                                    paymentType: $Enums.PaymentType.WEB3_CARDANO_V1
                                },
                                update: {
                                    paymentIdentifier: holderData[0].address,
                                    paymentType: $Enums.PaymentType.WEB3_CARDANO_V1
                                },
                                where: {
                                    registryEntryId_paymentType: {
                                        registryEntryId: existingEntry.id,
                                        paymentType: $Enums.PaymentType.WEB3_CARDANO_V1
                                    }
                                }
                            }
                        },
                        identifier: asset.asset,
                        registry: { connect: { id: source.id } },
                        capability: { connectOrCreate: { create: { name: metadataStringConvert(parsedMetadata.data.capability_name)!, version: metadataStringConvert(parsedMetadata.data.capability_version)! }, where: { name_version: { name: metadataStringConvert(parsedMetadata.data.capability_name)!, version: metadataStringConvert(parsedMetadata.data.capability_version)! } } } }
                    }
                })
            } else {
                await tx.registryEntry.create({
                    include: {
                        registry: true,
                        paymentIdentifier: true,
                        capability: true
                    },
                    data: {
                        lastUptimeCheck: new Date(),
                        uptimeCount: isAvailable == $Enums.Status.ONLINE ? 1 : 0,
                        uptimeCheckCount: 1,
                        status: isAvailable,
                        name: parsedMetadata.data.name,
                        description: metadataStringConvert(parsedMetadata.data.description),
                        api_url: metadataStringConvert(parsedMetadata.data.api_url)!,
                        company_name: metadataStringConvert(parsedMetadata.data.company_name),
                        identifier: asset.asset,
                        paymentIdentifier: { create: { paymentIdentifier: holderData[0].address, paymentType: $Enums.PaymentType.WEB3_CARDANO_V1 } },
                        registry: { connect: { id: source.id } },
                        capability: { connectOrCreate: { create: { name: metadataStringConvert(parsedMetadata.data.capability_name)!, version: metadataStringConvert(parsedMetadata.data.capability_version)! }, where: { name_version: { name: metadataStringConvert(parsedMetadata.data.capability_name)!, version: metadataStringConvert(parsedMetadata.data.capability_version)! } } } }

                    },
                })
            }

            return newEntry;
        })
    }))

    //filter out nulls -> tokens not following the metadata standard and burned tokens
    const resultingUpdatesFiltered = resultingUpdates.filter(x => x != null)
    //sort entries by creation date
    return resultingUpdatesFiltered.sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()))
}

export const cardanoRegistryService = { updateLatestCardanoRegistryEntries, updateCardanoAssets }