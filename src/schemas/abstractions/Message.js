'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/message';
const DOCUMENT_SCHEMA_VERSION = '1.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        // Core message fields
        text: z.string(),
        html: z.string().optional(),

        // Sender information
        sender: z.object({
            id: z.string(),
            name: z.string().optional(),
            email: z.string().email().optional(),
            username: z.string().optional(),
            displayName: z.string().optional(),
        }),

        // Channel/conversation information
        channel: z.object({
            id: z.string(),
            name: z.string().optional(),
            type: z.enum(['direct', 'group', 'channel', 'thread']).optional(),
        }),

        // Platform information
        platform: z.enum(['slack', 'teams', 'irc', 'discord', 'telegram', 'whatsapp', 'other']),

        // Timestamps
        timestamp: z.string().datetime(),
        editedAt: z.string().datetime().optional(),

        // Thread/reply information
        threadId: z.string().optional(),
        parentMessageId: z.string().optional(),
        replyCount: z.number().optional(),

        // Reactions and interactions
        reactions: z.array(z.object({
            emoji: z.string(),
            count: z.number(),
            users: z.array(z.string()).optional(),
        })).optional(),

        // Attachments
        attachments: z.array(z.object({
            type: z.enum(['file', 'image', 'video', 'link', 'other']),
            url: z.string().optional(),
            name: z.string().optional(),
            size: z.number().optional(),
            mimeType: z.string().optional(),
        })).optional(),

        // Mentions
        mentions: z.array(z.object({
            id: z.string(),
            name: z.string().optional(),
            type: z.enum(['user', 'channel', 'everyone']).optional(),
        })).optional(),

        // Platform-specific metadata
        platformMetadata: z.object({
            messageId: z.string().optional(),
            permalink: z.string().optional(),
            teamId: z.string().optional(),
            workspaceId: z.string().optional(),
        }).passthrough().optional(),

    }).passthrough(),
    metadata: z.object({
        source: z.string().optional(),
        workspaceId: z.string().optional(),
        imported: z.boolean().optional(),
        synced: z.boolean().optional(),
    }).passthrough().optional(),
});

export default class Message extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        // Inject Message-specific index options BEFORE super() so checksum uses correct fields
        options.indexOptions = {
            ...(options.indexOptions || {}),
            ftsSearchFields: ['data.text', 'data.sender.name', 'data.sender.displayName', 'data.channel.name'],
            vectorEmbeddingFields: ['data.text'],
            checksumFields: ['data.text', 'data.sender.id', 'data.channel.id', 'data.timestamp', 'data.platform'],
        };

        super(options);
    }

    /**
     * Create a Message from minimal data
     * @param {Object} data - Message data
     * @returns {Message} New Message instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Message(data);
    }

    /**
     * Create a Message from Slack data
     * @param {Object} slackMessage - Slack message object
     * @param {string} channelId - Channel ID
     * @param {string} channelName - Channel name
     * @returns {Message} New Message instance
     */
    static fromSlack(slackMessage, channelId, channelName) {
        return new Message({
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                text: slackMessage.text,
                sender: {
                    id: slackMessage.user,
                    username: slackMessage.username,
                },
                channel: {
                    id: channelId,
                    name: channelName,
                    type: slackMessage.channel_type || 'channel',
                },
                platform: 'slack',
                timestamp: new Date(parseFloat(slackMessage.ts) * 1000).toISOString(),
                threadId: slackMessage.thread_ts,
                reactions: slackMessage.reactions?.map(r => ({
                    emoji: r.name,
                    count: r.count,
                    users: r.users,
                })),
                platformMetadata: {
                    messageId: slackMessage.ts,
                    teamId: slackMessage.team,
                },
            },
        });
    }

    /**
     * Create a Message from Teams data
     * @param {Object} teamsMessage - Teams message object
     * @param {string} channelName - Channel name
     * @returns {Message} New Message instance
     */
    static fromTeams(teamsMessage, channelName) {
        return new Message({
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                text: teamsMessage.body?.content || '',
                html: teamsMessage.body?.contentType === 'html' ? teamsMessage.body.content : undefined,
                sender: {
                    id: teamsMessage.from?.user?.id,
                    displayName: teamsMessage.from?.user?.displayName,
                    email: teamsMessage.from?.user?.userIdentityType === 'aadUser'
                        ? teamsMessage.from?.user?.userPrincipalName
                        : undefined,
                },
                channel: {
                    id: teamsMessage.channelIdentity?.channelId,
                    name: channelName,
                    type: 'channel',
                },
                platform: 'teams',
                timestamp: teamsMessage.createdDateTime,
                editedAt: teamsMessage.lastModifiedDateTime,
                replyCount: teamsMessage.replyCount,
                mentions: teamsMessage.mentions?.map(m => ({
                    id: m.mentioned?.user?.id,
                    name: m.mentioned?.user?.displayName,
                    type: 'user',
                })),
                platformMetadata: {
                    messageId: teamsMessage.id,
                    permalink: teamsMessage.webUrl,
                },
            },
        });
    }

    /**
     * Create a Message from IRC data
     * @param {Object} ircMessage - IRC message object
     * @returns {Message} New Message instance
     */
    static fromIRC(ircMessage) {
        return new Message({
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                text: ircMessage.message,
                sender: {
                    id: ircMessage.nick,
                    username: ircMessage.nick,
                    name: ircMessage.nick,
                },
                channel: {
                    id: ircMessage.channel,
                    name: ircMessage.channel,
                    type: ircMessage.channel.startsWith('#') ? 'channel' : 'direct',
                },
                platform: 'irc',
                timestamp: ircMessage.timestamp || new Date().toISOString(),
                platformMetadata: {
                    host: ircMessage.host,
                },
            },
        });
    }

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return baseDocumentSchema;
    }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {},
        };
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}
