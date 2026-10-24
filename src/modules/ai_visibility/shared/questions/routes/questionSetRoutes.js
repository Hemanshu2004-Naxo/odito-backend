import express from 'express';
import auth from '../../../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../../../middleware/auth.middleware.js';
import {
  generateQuestions, listQuestionSets, getApproved, getQuestionSetById, updateQuestion, approve, discard, getQuestionBank,
} from '../controllers/questionSetController.js';
import { getProfile, updateProfile } from '../controllers/profileController.js';

/**
 * Mounted at /api/ai-visibility (routes/index.js). Provider-independent: the approved question set is what every answer
 * collector (ChatGPT, Gemini, Perplexity, Google AI Overview) will run. Authenticated and project-scoped.
 */
const router = express.Router();
router.use(auth);

router.get('/question-bank', getQuestionBank);
// The confirmed business profile that questions are generated from (stored on the project).
router.get('/projects/:id/profile', validateProjectAccess(), getProfile);
router.put('/projects/:id/profile', validateProjectAccess(), updateProfile);
router.post('/projects/:id/question-sets', validateProjectAccess(), generateQuestions);
router.get('/projects/:id/question-sets', validateProjectAccess(), listQuestionSets);
router.get('/projects/:id/question-sets/approved', validateProjectAccess(), getApproved);
router.get('/projects/:id/question-sets/:setId', validateProjectAccess(), getQuestionSetById);
router.patch('/projects/:id/question-sets/:setId/questions/:questionId', validateProjectAccess(), updateQuestion);
router.post('/projects/:id/question-sets/:setId/approve', validateProjectAccess(), approve);
router.post('/projects/:id/question-sets/:setId/discard', validateProjectAccess(), discard);

export default router;
