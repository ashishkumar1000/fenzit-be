export interface Env {
  WORKER_WEBHOOK_SECRET: string;
  BACKEND_URL: string;
}

interface R2EventMessage {
  bucket: string;
  key: string;
  eventType: string;
  size: number;
}

export default {
  async queue(batch: MessageBatch<R2EventMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { key, size } = msg.body;

      // Key pattern: {tenantId}/jobs/{jobId}/{folder}/{uuid}.{ext}
      const parts = key.split('/');
      if (parts.length < 5) {
        msg.ack(); // Malformed key — nothing to retry
        continue;
      }

      const [tenantId, , jobId, folder] = parts;
      const attachmentType = folder === 'photos' ? 'photo' : 'signature';

      try {
        const res = await fetch(
          `${env.BACKEND_URL}/internal/webhooks/storage`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.WORKER_WEBHOOK_SECRET}`,
            },
            body: JSON.stringify({
              key,
              size,
              tenantId,
              jobId,
              attachmentType,
            }),
          },
        );

        // 2xx → ack (confirmed)
        // 401/403 → retry: auth misconfig (e.g. secret rotation) is transient
        //   and acking would silently drop a real upload-confirm event.
        // other 4xx (404 not-found / 410 expired / 422 invalid) → ack: a fixed
        //   client-side problem that retrying won't fix.
        // 5xx → retry (transient backend error)
        if (res.ok) {
          msg.ack();
        } else if (
          res.status === 401 ||
          res.status === 403 ||
          res.status >= 500
        ) {
          msg.retry();
        } else {
          msg.ack();
        }
      } catch {
        msg.retry();
      }
    }
  },
};
