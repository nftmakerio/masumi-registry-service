import { adminAuthenticatedEndpointFactory } from '@/utils/endpoint-factory/admin-authenticated';
import { z } from 'zod';
import { $Enums, APIKeyStatus, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';
import { apiKeyService } from '@/services/api-key/api-key.service';


export const getAPIKeySchemaInput = z.object({
    id: z.string().max(550).optional(),
    apiKey: z.string().max(550).optional()
})


export const getAPIKeySchemaOutput = z.object({

    id: z.string(),
    apiKey: z.string(),
    permission: z.nativeEnum(Permission),
    usageLimited: z.boolean(),
    maxUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000).nullable(),
    accumulatedUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000),
    status: z.nativeEnum(APIKeyStatus),

});

export const queryAPIKeyEndpointGet = adminAuthenticatedEndpointFactory.build({
    method: "get",
    input: getAPIKeySchemaInput,
    output: getAPIKeySchemaOutput,
    handler: async ({ input, options, logger }) => {
        let data = await apiKeyService.getApiKey(input.id, input.apiKey)

        if (!data)
            throw createHttpError(404, "Not found")

        return data;
    },
});

export const addAPIKeySchemaInput = z.object({
    usageLimited: z.boolean().default(false),
    maxUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000).default(0),
    permission: z.nativeEnum(Permission).default(Permission.USER),
})

export const addAPIKeySchemaOutput = z.object({
    id: z.string(),
    apiKey: z.string(),
    permission: z.nativeEnum(Permission),
    usageLimited: z.boolean(),
    maxUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000).nullable(),
    accumulatedUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000),
    status: z.nativeEnum(APIKeyStatus),

})

export const addAPIKeyEndpointPost = adminAuthenticatedEndpointFactory.build({
    method: "post",
    input: addAPIKeySchemaInput,
    output: addAPIKeySchemaOutput,
    handler: async ({ input, options, logger }) => {
        let result = await apiKeyService.addApiKey(input.permission, input.usageLimited, input.maxUsageCredits)
        return result;
    },
});

export const updateAPIKeySchemaInput = z.object({
    id: z.string().max(150).optional(),
    apiKey: z.string().max(550).optional(),
    usageLimited: z.boolean().default(false),
    maxUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000).default(0),
    status: z.nativeEnum(APIKeyStatus).default(APIKeyStatus.ACTIVE),
})

export const updateAPIKeySchemaOutput = z.object({
    id: z.string(),
    apiKey: z.string(),
    permission: z.nativeEnum(Permission),
    usageLimited: z.boolean(),
    maxUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000).nullable(),
    accumulatedUsageCredits: z.number({ coerce: true }).int().min(0).max(1000000),
    status: z.nativeEnum(APIKeyStatus),
})

export const updateAPIKeyEndpointPatch = adminAuthenticatedEndpointFactory.build({
    method: "patch",
    input: updateAPIKeySchemaInput,
    output: updateAPIKeySchemaOutput,
    handler: async ({ input, options, logger }) => {

        let result = await apiKeyService.updateApiKey(input.id, input.apiKey, input.status, input.usageLimited, input.maxUsageCredits)
        if (!result)
            throw createHttpError(404, "Not found")

        return result
    },
});

export const deleteAPIKeySchemaInput = z.object({
    id: z.string().max(150).optional(),
    apiKey: z.string().max(550).optional()
})

export const deleteAPIKeySchemaOutput = z.object({
    id: z.string(),
    apiKey: z.string(),
});

export const deleteAPIKeyEndpointDelete = adminAuthenticatedEndpointFactory.build({
    method: "delete",
    input: deleteAPIKeySchemaInput,
    output: deleteAPIKeySchemaOutput,

    handler: async ({ input, options, logger }) => {

        let result = await apiKeyService.deleteApiKey(input.id, input.apiKey)

        if (!result)
            throw createHttpError(404, "Not found")

        return result
    },
});