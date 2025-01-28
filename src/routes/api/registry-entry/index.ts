import { authenticatedEndpointFactory } from '@/utils/endpoint-factory/authenticated';
import { z } from 'zod';
import { ez } from "express-zod-api";
import { tokenCreditService } from '@/services/token-credit';
import { $Enums, Network } from '@prisma/client';
import { registryEntryService } from '@/services/registry-entry';

export const queryRegistrySchemaInput = z.object({
    network: z.nativeEnum(Network),
    limit: z.number({ coerce: true }).int().min(1).max(50).default(10),
    //optional data
    cursorId: z.string().min(1).max(50).optional(),
    filter: z.object({
        paymentTypes: z.array(z.nativeEnum($Enums.PaymentType)).max(5).optional(),
        status: z.array(z.nativeEnum($Enums.Status)).max(5).optional(),
        registryIdentifier: z.string().min(1).max(250).optional(),
        assetIdentifier: z.string().min(1).max(250).optional(),
        tags: z.array(z.string().min(1).max(150)).optional(),
        capability: z.object({ name: z.string().min(1).max(150), version: z.string().max(150).optional() }).optional(),
    }).optional(),
    //force refresh
    minRegistryDate: ez.dateIn().optional(),
    minHealthCheckDate: ez.dateIn().optional(),

})

export const queryRegistrySchemaOutput = z.object({
    entries: z.array(z.object(
        {
            registry: z.object({
                type: z.nativeEnum($Enums.RegistryEntryType),
                identifier: z.string().nullable(),
                url: z.string().nullable(),
            }),
            capability: z.object({
                name: z.string(),
                version: z.string(),
                description: z.string().nullable(),
            }),
            name: z.string(),
            description: z.string().nullable(),
            status: z.nativeEnum($Enums.Status),
            id: z.string(),
            lastUptimeCheck: ez.dateOut(),
            uptimeCount: z.number(),
            uptimeCheckCount: z.number(),
            api_url: z.string(),
            author_name: z.string().nullable(),
            author_organization: z.string().nullable(),
            author_contact: z.string().nullable(),
            image: z.string().nullable(),
            privacy_policy: z.string().nullable(),
            terms_and_condition: z.string().nullable(),
            other_legal: z.string().nullable(),
            requests_per_hour: z.number().nullable(),
            tags: z.array(z.object({
                value: z.string()
            })).nullable(),
            identifier: z.string(),
        }
    ))
});

export const queryRegistryEntryPost = authenticatedEndpointFactory.build({
    method: "post",
    input: queryRegistrySchemaInput,
    output: queryRegistrySchemaOutput,
    handler: async ({ input, options, logger }) => {
        logger.info("Querying registry", input.paymentTypes);
        const tokenCost = 0;
        //TODO update cost model
        //TODO add custom errors
        await tokenCreditService.handleTokenCredits(options, tokenCost, "query for: " + input.filter?.capability?.name);
        const data = await registryEntryService.getRegistryEntries(input);

        return { entries: data.slice(0, Math.min(input.limit, data.length)) }
    },
});
