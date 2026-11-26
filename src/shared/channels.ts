export interface TopicChannel {
  botId: string;
  parentBotId: string;
  ownerId: string;
  topic: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface CreateChannelInput {
  topic: string;
  description?: string;
  instructions?: string;
}

export interface ChannelListResponse {
  channels: TopicChannel[];
}
