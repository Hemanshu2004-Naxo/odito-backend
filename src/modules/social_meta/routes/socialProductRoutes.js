import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { handleCatalogImageUpload } from '../middleware/catalogImageUpload.js';
import {
  listProductsHandler, getProductHandler, createProductHandler, updateProductHandler, deleteProductHandler,
  addProductImageHandler, replaceProductImageHandler, deleteProductImageHandler, updateProductImageHandler, reorderProductImagesHandler,
} from '../controller/socialProductController.js';

const router = express.Router();

// Product Catalog (user-owned structured products). Every route: JWT (auth) + validateProjectAccess(), which reads
// projectId from the query (GET / DELETE) or the body (POST / PATCH / PUT) and rejects another user's project.
// The product and image ids come from the URL and are re-checked against that project in the service.
//
// Image uploads are multipart/form-data, so multer must run BEFORE validateProjectAccess() (the projectId form
// field only exists after multer parsed the body) — same ordering as POST /social/media/upload.
router.get('/', auth, validateProjectAccess(), listProductsHandler);
router.post('/', auth, validateProjectAccess(), createProductHandler);

router.get('/:productId', auth, validateProjectAccess(), getProductHandler);
router.patch('/:productId', auth, validateProjectAccess(), updateProductHandler);
router.delete('/:productId', auth, validateProjectAccess(), deleteProductHandler);

router.post('/:productId/images', auth, handleCatalogImageUpload, validateProjectAccess(), addProductImageHandler);
// `reorder` is declared before `:mediaId` so it is never read as an image id.
router.patch('/:productId/images/reorder', auth, validateProjectAccess(), reorderProductImagesHandler);
router.patch('/:productId/images/:mediaId', auth, validateProjectAccess(), updateProductImageHandler);
router.put('/:productId/images/:mediaId', auth, handleCatalogImageUpload, validateProjectAccess(), replaceProductImageHandler);
router.delete('/:productId/images/:mediaId', auth, validateProjectAccess(), deleteProductImageHandler);

export default router;
