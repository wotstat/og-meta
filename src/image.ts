export const imageEncodings = {
  png: { path: '/analytics/image.png', contentType: 'image/png' },
  jpeg: { path: '/analytics/image.jpg', contentType: 'image/jpeg' },
} as const

export type ImageEncoding = keyof typeof imageEncodings

const encoding = Bun.env.IMAGE_FORMAT ?? 'jpeg'
if (encoding !== 'png' && encoding !== 'jpeg') throw new Error('IMAGE_FORMAT must be png or jpeg')
export const preferredImageEncoding: ImageEncoding = encoding

export const imageQuality = Number(Bun.env.IMAGE_QUALITY ?? 98)
if (!Number.isInteger(imageQuality) || imageQuality < 0 || imageQuality > 100)
  throw new Error('IMAGE_QUALITY must be an integer from 0 to 100')
