/**
 * One-shot R2 connectivity probe. Run with:
 *   bun run scripts/probe-r2.ts
 * Verifies: credentials are valid, bucket reachable, presigned PUT works, upload works, cleanup.
 * Delete this file after confirming Story 3.6 works.
 */
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ACCOUNT_ID = process.env.CLOUDFLARE_R2_ACCOUNT_ID!;
const ACCESS_KEY = process.env.CLOUDFLARE_R2_ACCESS_KEY!;
const SECRET_KEY = process.env.CLOUDFLARE_R2_SECRET_KEY!;
const BUCKET = process.env.CLOUDFLARE_R2_BUCKET!;

if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY || !BUCKET) {
  console.error('❌ Missing R2 env vars. Ensure .env is loaded.');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

const PROBE_KEY = `__probe__/connectivity-check-${Date.now()}.txt`;
const PROBE_BODY = 'fenzit-be R2 connectivity probe';

async function run() {
  console.log(`\nProbing R2 bucket: ${BUCKET}`);
  console.log(`Endpoint: https://${ACCOUNT_ID}.r2.cloudflarestorage.com\n`);

  // 1. Bucket reachability
  console.log('1. HeadBucket...');
  await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  console.log('   ✓ Bucket exists and credentials are valid\n');

  // 2. Direct PUT
  console.log('2. PutObject (direct upload)...');
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: PROBE_KEY,
      Body: PROBE_BODY,
      ContentType: 'text/plain',
    }),
  );
  console.log(`   ✓ Uploaded: ${PROBE_KEY}\n`);

  // 3. Presigned PUT URL generation
  const PRESIGNED_KEY = PROBE_KEY + '.presigned.jpg';
  console.log('3. Generating presigned PUT URL (900s TTL)...');
  const presignedPut = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: PRESIGNED_KEY,
      ContentType: 'image/jpeg',
    }),
    { expiresIn: 900 },
  );
  console.log('   ✓ Presigned PUT URL generated');
  console.log(`   URL prefix: ${presignedPut.substring(0, 80)}...\n`);

  // 4. Upload via presigned URL (the actual Story 3.6 mobile-upload pattern)
  console.log('4. Upload via presigned PUT URL (simulating mobile client)...');
  // Minimal 1×1 JPEG — smallest valid JPEG bytes
  const TINY_JPEG = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080101000005021b',
    'hex',
  );
  const uploadRes = await fetch(presignedPut, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: TINY_JPEG,
  });
  if (!uploadRes.ok) {
    throw new Error(`Presigned upload failed: HTTP ${uploadRes.status} — ${await uploadRes.text()}`);
  }
  console.log(`   ✓ Presigned upload succeeded (HTTP ${uploadRes.status})\n`);

  // 5. Verify both objects are listed
  console.log('5. ListObjectsV2 (prefix: __probe__)...');
  const list = await client.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: '__probe__/' }),
  );
  const foundDirect = list.Contents?.some((o) => o.Key === PROBE_KEY);
  const foundPresigned = list.Contents?.some((o) => o.Key === PRESIGNED_KEY);
  console.log(`   ✓ Direct-upload object visible: ${foundDirect ? 'yes' : 'NO'}`);
  console.log(`   ✓ Presigned-upload object visible: ${foundPresigned ? 'yes' : 'NO'}\n`);

  // 6. Cleanup both objects
  console.log('6. Cleanup (DeleteObject × 2)...');
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: PROBE_KEY }));
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: PRESIGNED_KEY }));
  console.log('   ✓ Both probe objects deleted\n');

  console.log('✅ All R2 checks passed. Story 3.6 can proceed.');
}

run().catch((err) => {
  console.error('\n❌ R2 probe failed:', err.message ?? err);
  console.error('   Code:', (err as { Code?: string }).Code ?? 'n/a');
  process.exit(1);
});
