require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const app = express();
const port = process.env.PORT || 3000;

const { ObjectId } = require("mongodb");

//Middlewares
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

var admin = require("firebase-admin");

var serviceAccount = require("./service_key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyFirebaseToken = async (req, res, next) => {
  // console.log("Verifying Firebase token...", req.headers);
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

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster-news.9k1ap72.mongodb.net/?retryWrites=true&w=majority&appName=Cluster-News`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const usersCollection = client.db("usersDB").collection("users");

    // POST /users
    app.post("/users", async (req, res) => {
      const user = req.body;
      const existingUser = await usersCollection.findOne({ email: user.email });

      if (existingUser) {
        return res.status(200).send({ message: "User already exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users/make-admin/:email", async (req, res) => {
      const email = req.params.email;
      console.log("Gets email", email);
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

    app.patch(
      "/users/make-admin/:email",
      verifyFirebaseToken,
      async (req, res) => {
        const email = req.params.email;

        // only rik.shelby@gmail.com can promote
        if (req.decoded?.email !== "rik.shelby@gmail.com") {
          return res.status(403).send({ error: true, message: "Unauthorized" });
        }

        const filter = { email };
        const update = { $set: { role: "admin" } };
        const result = await usersCollection.updateOne(filter, update);
        res.send(result);
      }
    );

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to my Newspaper Fullstack Project: The DailyCommit");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
