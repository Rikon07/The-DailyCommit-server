require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const app = express();
const port = process.env.PORT || 3000;

// --- Stripe Setup ---
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// --- Firebase Admin Setup ---
const serviceAccount = require("./service_key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// --- Middleware ---
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://the-daily-commit-c5e84.web.app"
    ],
    credentials: true,
  })
);
app.use(express.json());

// --- JWT Auth Middleware ---
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers?.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (err) {
    res.status(401).send({ message: "Unauthorized" });
  }
};

// --- MongoDB Setup ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster-news.9k1ap72.mongodb.net/?retryWrites=true&w=majority&appName=Cluster-News`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// --- Main App Logic ---
async function run() {
  try {
    // await client.connect();
    const usersCollection = client.db("usersDB").collection("users");
    const articlesCollection = client.db("articlesDB").collection("articles");
    const publishersCollection = client.db("articlesDB").collection("publishers");

    // --- User Routes ---

    // Get all users (with pagination)
    app.get("/users", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;
      const total = await usersCollection.countDocuments();
      const users = await usersCollection.find().skip(skip).limit(limit).toArray();
      res.send({ users, total });
    });

    // Register user
    app.post("/users", async (req, res) => {
      const user = req.body;
      const existingUser = await usersCollection.findOne({ email: user.email });
      if (existingUser) {
        return res.status(200).send({ message: "User already exists" });
      }
      if (!user.premiumTaken) user.premiumTaken = null;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // Get single user (for profile, navbar, etc)
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      if (!user) return res.status(404).send({ message: "User not found" });
      res.send(user);
    });

    // Update user profile (name, photo)
    app.patch("/users/:email", async (req, res) => {
      const email = req.params.email;
      const { name, photo } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { name, photo } }
      );
      res.send(result);
    });

    // Make admin (only by super admin)
    app.patch("/users/make-admin/:email", verifyFirebaseToken, async (req, res) => {
      const email = req.params.email;
      if (req.decoded?.email !== "rik.shelby@gmail.com") {
        return res.status(403).send({ error: true, message: "Unauthorized" });
      }
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role: "admin" } }
      );
      res.send(result);
    });

    // Check if user is admin
    app.get("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({ admin: user?.role === "admin" });
    });

    // Update premium status (subscription)
    app.patch("/users/premium/:email", verifyFirebaseToken, async (req, res) => {
      const email = req.params.email;
      const { premiumTaken, type } = req.body;
      const updateFields = { premiumTaken };
      if (type) updateFields.type = type;
      const result = await usersCollection.updateOne(
        { email },
        { $set: updateFields }
      );
      res.send(result);
    });

    // --- Article Routes ---

    // Get all articles (public, with filters)
    // app.get("/articles", async (req, res) => {
    //   const { publisher, tags, search, isPremium } = req.query;
    //   const query = { status: "approved" };
    //   if (publisher) query.publisher = publisher;
    //   if (tags) query.tags = { $in: tags.split(",") };
    //   if (search) query.title = { $regex: search, $options: "i" };
    //   if (isPremium === "true") query.isPremium = true;
    //   const articles = await articlesCollection.find(query).toArray();
    //   res.send(articles);
    // });
    // Get all articles (public, with filters and pagination)
app.get("/articles", async (req, res) => {
  const { publisher, tags, search, isPremium, page = 1, limit = 9 } = req.query;
  const query = { status: "approved" };

  if (publisher) query.publisher = publisher;
  if (tags) query.tags = { $in: tags.split(",") };
  if (search) query.title = { $regex: search, $options: "i" };
  if (isPremium === "true") query.isPremium = true;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const total = await articlesCollection.countDocuments(query);
  const articles = await articlesCollection.find(query).skip(skip).limit(parseInt(limit)).toArray();

  res.send({ articles, total });
});

    // Get all articles (admin, paginated)
    app.get("/admin/articles", verifyFirebaseToken, async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;
      const total = await articlesCollection.countDocuments();
      const articles = await articlesCollection.find().skip(skip).limit(limit).toArray();
      res.send({ articles, total });
    });

    // Get all articles by a user
    app.get("/my-articles/:email", async (req, res) => {
      const email = req.params.email;
      const articles = await articlesCollection.find({ authorEmail: email }).toArray();
      res.send(articles);
    });

    // Get single article and increment view count
    app.get("/articles/:id", async (req, res) => {
      const id = req.params.id;
      let article;
      try {
        article = await articlesCollection.findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $inc: { views: 1 } },
          { returnDocument: "after" }
        );
      } catch (e) {
        return res.status(404).send({ message: "Article not found" });
      }
      if (!article) return res.status(404).send({ message: "Article not found" });
      res.send(article);
    });

    // Add article (limit normal users to 1)
    app.post("/articles", async (req, res) => {
      try {
        const article = req.body;
        const user = await usersCollection.findOne({ email: article.authorEmail });
        // If user is normal, check if they already have an article
        if (user?.type !== "premium") {
          const existing = await articlesCollection.findOne({ authorEmail: article.authorEmail });
          if (existing) {
            return res.status(403).send({ message: "Normal users can only post 1 article. Upgrade to premium for unlimited posts." });
          }
        }
        const result = await articlesCollection.insertOne(article);
        res.send({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error submitting article:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Update article (by id)
    app.patch("/articles/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const updateData = req.body;
      const result = await articlesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData }
      );
      res.send(result);
    });

    // Approve article
    app.patch("/articles/approve/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const result = await articlesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );
      res.send(result);
    });

    // Decline article
    app.patch("/articles/decline/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const { reason } = req.body;
      const result = await articlesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "declined", declineReason: reason } }
      );
      res.send(result);
    });

    // Delete article
    app.delete("/articles/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const result = await articlesCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Make article premium
    app.patch("/articles/premium/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const result = await articlesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isPremium: true } }
      );
      res.send(result);
    });

    // --- Publisher Routes ---

    // Add publisher
    app.post("/publishers", async (req, res) => {
      const { name, logo } = req.body;
      if (!name || !logo) return res.status(400).send({ message: "Name and logo required" });
      const result = await publishersCollection.insertOne({ name, logo });
      res.send(result);
    });

    // Get all publishers
    app.get("/publishers", async (req, res) => {
      const publishers = await publishersCollection.find().toArray();
      res.send(publishers);
    });

    // --- Contributors & Statistics ---

    // Top contributors
    app.get("/contributors/top", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$authorEmail",
            count: { $sum: 1 },
            name: { $first: "$authorName" },
            photo: { $first: "$authorPhoto" },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ];
      const contributors = await articlesCollection.aggregate(pipeline).toArray();
      res.send(contributors);
    });

    // User statistics
    // app.get("/statistics/users", async (req, res) => {
    //   const users = await usersCollection.find().toArray();
    //   const total = users.length;
    //   const premium = users.filter(u => u.type === "premium").length;
    //   const normal = users.filter(u => u.type === "normal" || !u.type).length;
    //   res.send({ total, premium, normal });
    // });
    app.get("/statistics/users", async (req, res) => {
  const users = await usersCollection.find().toArray();
  const articles = await articlesCollection.find().toArray();
  const totalUsers = users.length;
  const premiumUsers = users.filter(u => u.type === "premium").length;
  const totalArticles = articles.length;
  const premiumArticles = articles.filter(a => a.isPremium).length;
  res.send({
    totalUsers,
    premiumUsers,
    totalArticles,
    premiumArticles,
  });
});

    // --- Stripe Payment ---

    app.post("/create-payment-intent", async (req, res) => {
      const { price } = req.body;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: price * 100, // Stripe expects cents
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // --- Misc/Root ---

    app.get("/", (req, res) => {
      res.send("Welcome to my Newspaper Fullstack Project: The DailyCommit");
    });

    // --- Admin: Get user by email (for admin panel) ---
    app.get("/users/make-admin/:email", async (req, res) => {
      const email = req.params.email;
      try {
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }
        res.json(user);
      } catch (err) {
        res.status(500).json({ message: "Server error", error: err.message });
      }
    });

    // --- MongoDB Connection Test ---
    // await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);
app.get("/", (req, res) => {
  res.send("Welcome to my Newspaper Fullstack Project: The DailyCommit");
});
// --- Start Server ---
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});