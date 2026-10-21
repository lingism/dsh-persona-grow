/**
 * 备份加密内核：打包目录、解包、AES-256-GCM 加解密。
 * 从 profiles.js 拆出来——它跟多档案管理是两件事。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const CIPHER = 'aes-256-gcm'

function packDir(rootDir) {
  const files = {}
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const relPath = rel === '' ? name : rel + '/' + name
      if (statSync(full).isDirectory()) walk(full, relPath)
      else files[relPath] = readFileSync(full).toString('base64')
    }
  }
  walk(rootDir, '')
  return files
}

function unpackDir(files, rootDir) {
  for (const rel of Object.keys(files)) {
    const full = join(rootDir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, Buffer.from(files[rel], 'base64'))
  }
}

function encryptJson(obj, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv(CIPHER, key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') }
}

function decryptJson(payload, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(payload.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'))
  const out = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()])
  return JSON.parse(out.toString('utf8'))
}

export { packDir, unpackDir, encryptJson, decryptJson }
