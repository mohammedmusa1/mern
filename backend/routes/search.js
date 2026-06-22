const express = require('express');
const router = express.Router();
const Product = require('../models/product');

// Escape special regex characters to prevent NoSQL injection via regex
const escapeRegex = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @swagger
 * /api/search:
 *   get:
 *     summary: Search for products
 *     description: Search by name or description. Returns all products if no query given.
 *     tags:
 *       - Search
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         required: false
 *         description: Search query
 *     responses:
 *       200:
 *         description: Matching products
 *       500:
 *         description: Server error
 */
router.get('/', async (req, res, next) => {
  try {
    const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (!raw) {
      const all = await Product.find().lean();
      return res.json(all);
    }

    const safe = escapeRegex(raw);
    const regex = new RegExp(safe, 'i');

    const products = await Product.find({
      $or: [{ name: { $regex: regex } }, { description: { $regex: regex } }],
    })
      .limit(100)
      .lean();

    res.json(products);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
