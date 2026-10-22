import productService from '../service/socialProductService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialProductController — HTTP only. Every route runs behind auth + validateProjectAccess()
 * (see routes/socialProductRoutes.js), which sets req.projectId / req.userId; those are the only identities used
 * here. productId / mediaId come from the URL and are re-checked against that project by the service, so a
 * product of Project A is "not found" from Project B.
 *
 * Success bodies carry the PUBLIC product shape only (no storage keys, no user ids).
 */

const STATUS = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_SKU: 409,
  DUPLICATE_SLUG: 409,
  PRODUCT_LIMIT_REACHED: 409,
  IMAGE_LIMIT_REACHED: 409,
  MEDIA_TOO_LARGE: 413,
  MEDIA_UPLOAD_FAILED: 500,
  // every other code (INVALID_PRODUCT, UNKNOWN_FIELD, EMPTY_UPDATE, INVALID_BODY, INVALID_ORDER, INVALID_MEDIA_TYPE, MEDIA_TOO_SMALL, MEDIA_REQUIRED) is a 400
};

function send(res, result, { ok = 200 } = {}) {
  if (!result.success) {
    const status = STATUS[result.error.code] || 400;
    return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
  }
  const { success: _success, ...data } = result;
  return res.status(ok).json(ResponseUtil.success(data));
}

function guard(name, handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      LoggerUtil.error(`[SOCIAL_PRODUCTS] ${name} failed`, { message: error.message }, { projectId: req.projectId });
      return res.status(500).json(ResponseUtil.error('The product request failed.', 500, { code: 'SOCIAL_PRODUCTS_FAILED' }));
    }
  };
}

const uploadedBuffer = (req) => (req.file && Buffer.isBuffer(req.file.buffer) ? req.file.buffer : null);
const noFile = (res) => res.status(400).json(ResponseUtil.error('No file was uploaded.', 400, { code: 'MEDIA_REQUIRED' }));

export const listProductsHandler = guard('list', async (req, res) => {
  // `?status[$ne]=x` parses to an object: refuse anything that is not a plain string instead of ignoring it.
  const raw = req.query.status;
  if (raw !== undefined && typeof raw !== 'string') {
    return res.status(400).json(ResponseUtil.error('status must be text.', 400, { code: 'INVALID_PRODUCT' }));
  }
  return send(res, await productService.listProducts(req.projectId, { status: raw || null }));
});

export const getProductHandler = guard('get', async (req, res) => send(res, await productService.getProduct(req.projectId, req.params.productId)));

export const createProductHandler = guard('create', async (req, res) => send(res, await productService.createProduct(req.projectId, req.userId, req.body), { ok: 201 }));

export const updateProductHandler = guard('update', async (req, res) => send(res, await productService.updateProduct(req.projectId, req.params.productId, req.userId, req.body)));

export const deleteProductHandler = guard('delete', async (req, res) => send(res, await productService.deleteProduct(req.projectId, req.params.productId)));

export const addProductImageHandler = guard('addImage', async (req, res) => {
  const buffer = uploadedBuffer(req);
  if (!buffer) return noFile(res);
  return send(res, await productService.addProductImage(req.projectId, req.params.productId, req.userId, buffer), { ok: 201 });
});

export const replaceProductImageHandler = guard('replaceImage', async (req, res) => {
  const buffer = uploadedBuffer(req);
  if (!buffer) return noFile(res);
  return send(res, await productService.replaceProductImage(req.projectId, req.params.productId, req.params.mediaId, req.userId, buffer));
});

export const deleteProductImageHandler = guard('deleteImage', async (req, res) => send(res, await productService.deleteProductImage(req.projectId, req.params.productId, req.params.mediaId, req.userId)));

export const updateProductImageHandler = guard('updateImage', async (req, res) => send(res, await productService.updateProductImage(req.projectId, req.params.productId, req.params.mediaId, req.userId, req.body)));

export const reorderProductImagesHandler = guard('reorderImages', async (req, res) => send(res, await productService.reorderProductImages(req.projectId, req.params.productId, req.userId, req.body)));

export default {
  listProductsHandler, getProductHandler, createProductHandler, updateProductHandler, deleteProductHandler,
  addProductImageHandler, replaceProductImageHandler, deleteProductImageHandler, updateProductImageHandler, reorderProductImagesHandler,
};
