import * as crypto from 'crypto';

const algorithm = 'aes-256-gcm';

export function encryptPrivateKey(privateKey: string, userId: number): { encrypted: string, iv: string, authTag: string } {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET not set');
  
  const key = crypto.scryptSync(secret + userId.toString(), 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

export function decryptPrivateKey(encryptedData: { encrypted: string, iv: string, authTag: string }, userId: number): string {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET not set');
  
  const key = crypto.scryptSync(secret + userId.toString(), 'salt', 32);
  const decipher = crypto.createDecipheriv(
    algorithm, 
    key, 
    Buffer.from(encryptedData.iv, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
  
  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
