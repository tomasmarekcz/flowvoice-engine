import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchTransport } from "./sink";

// Credentials come from the EC2 instance role automatically; nothing is configured in code.
export function createAwsTransport(region: string): CloudWatchTransport {
  const client = new CloudWatchLogsClient({ region });
  return {
    async ensureStream(group, stream) {
      try {
        await client.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: stream }));
      } catch (e) {
        if ((e as { name?: string })?.name !== "ResourceAlreadyExistsException") throw e;
      }
    },
    async put(group, stream, events) {
      await client.send(new PutLogEventsCommand({ logGroupName: group, logStreamName: stream, logEvents: events }));
    },
  };
}
