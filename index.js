const express = require("express");
const cors = require("cors");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;

const serviceAccount = require("./smart-deals-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

//middleware config
app.use(cors());
app.use(express.json());

const logger = (req, res, next) => {
  next();
};

const verifyFirebaseToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.token_email = decoded.email;
    next();
  } catch {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const verifyJWTToken = (req, res, next) => {
  console.log("in middleware", req.headers);
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = authorization.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.0zmmwcn.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req, res) => {
  res.send("Smart server is running!");
});

async function run() {
  try {
    await client.connect();

    const db = client.db("smart_db");
    const productsCollection = db.collection("products");
    const bidsCollection = db.collection("bids");
    const usersCollection = db.collection("user");

    //jwt related APIs
    app.post("/getToken", (req, res) => {
      const loggedUser = req.body;
      const token = jwt.sign(
        { email: loggedUser.email },
        process.env.JWT_SECRET,
        {
          expiresIn: "1h",
        }
      );
      res.send({ token });
    });

    //Users API
    app.post("/users", async (req, res) => {
      const newUser = req.body;

      const email = req.body.email;
      const query = { email: email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        res.send({ message: "user already exists in the database" });
      } else {
        const result = await usersCollection.insertOne(newUser);
        res.send(result);
      }
    });

    //Products API
    
    // Get all products or filter by seller email
    app.get("/products", async (req, res) => {
      const email = req.query.email;
      const query = {};
      
      if (email) {
        query.email = email; // Filter by seller email
      }
      
      const cursor = productsCollection.find(query).sort({ created_at: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Get latest 5 products
    app.get("/latest-products", async (req, res) => {
      const cursor = productsCollection
        .find({ status: "pending" }) // Only show products that are not sold
        .sort({ created_at: -1 })
        .limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Get single product by ID
    app.get("/products/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid product ID" });
      }
      const query = { _id: new ObjectId(id) };
      const result = await productsCollection.findOne(query);
      
      if (!result) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      res.send(result);
    });

    // Create new product
    app.post("/products", verifyFirebaseToken, async (req, res) => {
      const newProduct = req.body;
      
      // Verify the email in token matches the product email
      if (req.token_email !== newProduct.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      
      const result = await productsCollection.insertOne(newProduct);
      res.send(result);
    });

    // Update entire product (PUT)
    app.put("/products/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid product ID" });
      }
      
      const updatedProduct = req.body;
      const query = { _id: new ObjectId(id) };
      
      // Check if user owns this product
      const existingProduct = await productsCollection.findOne(query);
      if (!existingProduct) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      if (existingProduct.email !== req.token_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      
      // Don't allow changing email or created_at
      delete updatedProduct._id;
      delete updatedProduct.email;
      delete updatedProduct.created_at;
      
      const update = {
        $set: updatedProduct,
      };
      
      const result = await productsCollection.updateOne(query, update);
      res.send(result);
    });

    // Update product status (PATCH)
    app.patch("/products/status/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid product ID" });
      }
      
      if (!status || !["pending", "sold"].includes(status)) {
        return res.status(400).send({ message: "Invalid status. Must be 'pending' or 'sold'" });
      }
      
      const query = { _id: new ObjectId(id) };
      
      // Check if user owns this product
      const existingProduct = await productsCollection.findOne(query);
      if (!existingProduct) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      if (existingProduct.email !== req.token_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      
      const update = {
        $set: { status },
      };
      
      const result = await productsCollection.updateOne(query, update);
      res.send(result);
    });

    // Delete product
    app.delete("/products/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid product ID" });
      }
      
      const query = { _id: new ObjectId(id) };
      
      // Check if user owns this product
      const existingProduct = await productsCollection.findOne(query);
      if (!existingProduct) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      if (existingProduct.email !== req.token_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      
      // Delete all bids for this product first
      await bidsCollection.deleteMany({ product: id });
      
      // Then delete the product
      const result = await productsCollection.deleteOne(query);
      res.send(result);
    });

    // Bids related APIs

    // Get bids by buyer email
    app.get("/bids", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      
      if (email) {
        query.buyer_email = email;
        if (email !== req.token_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      
      const cursor = bidsCollection.find(query).sort({ bid_price: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Get all bids for a specific product
    app.get("/products/bids/:productId", verifyFirebaseToken, async (req, res) => {
      const productId = req.params.productId;
      
      // Verify the requester owns this product
      const product = await productsCollection.findOne({
        _id: new ObjectId(productId),
      });
      
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      // Allow product owner or any authenticated user to see bids
      // (In your design, buyers can see all bids on a product)
      
      const query = { product: productId };
      const cursor = bidsCollection.find(query).sort({ bid_price: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Place a new bid
    app.post("/bids", verifyFirebaseToken, async (req, res) => {
      const newBid = req.body;
      
      // Verify the email matches
      if (req.token_email !== newBid.buyer_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      
      // Check if product exists and is still available
      const product = await productsCollection.findOne({
        _id: new ObjectId(newBid.product),
      });
      
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      if (product.status === "sold") {
        return res.status(400).send({ message: "Product is already sold" });
      }
      
      // Don't allow seller to bid on their own product
      if (product.email === req.token_email) {
        return res.status(400).send({ message: "Cannot bid on your own product" });
      }
      
      const result = await bidsCollection.insertOne(newBid);
      res.send(result);
    });

    // Update bid status (Accept/Reject)
    app.patch("/bids/status/:id", verifyFirebaseToken, async (req, res) => {
      const bidId = req.params.id;
      const { status } = req.body;
      
      if (!ObjectId.isValid(bidId)) {
        return res.status(400).send({ message: "Invalid bid ID" });
      }
      
      if (!status || !["pending", "confirmed", "rejected"].includes(status)) {
        return res.status(400).send({
          message: "Invalid status. Must be 'pending', 'confirmed', or 'rejected'",
        });
      }
      
      // Get the bid
      const bid = await bidsCollection.findOne({ _id: new ObjectId(bidId) });
      if (!bid) {
        return res.status(404).send({ message: "Bid not found" });
      }
      
      // Get the product to verify ownership
      const product = await productsCollection.findOne({
        _id: new ObjectId(bid.product),
      });
      
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      // Only product owner can accept/reject bids
      if (product.email !== req.token_email) {
        return res.status(403).send({ message: "Only product owner can update bid status" });
      }
      
      // If confirming a bid
      if (status === "confirmed") {
        // Update the bid status
        await bidsCollection.updateOne(
          { _id: new ObjectId(bidId) },
          { $set: { status: "confirmed" } }
        );
        
        // Mark product as sold
        await productsCollection.updateOne(
          { _id: new ObjectId(bid.product) },
          { $set: { status: "sold" } }
        );
        
        // Delete all other pending bids for this product
        await bidsCollection.deleteMany({
          product: bid.product,
          _id: { $ne: new ObjectId(bidId) },
        });
        
        res.send({
          message: "Bid confirmed, product marked as sold, other bids deleted",
          modifiedCount: 1,
        });
      } else {
        // Just update the bid status for rejection
        const result = await bidsCollection.updateOne(
          { _id: new ObjectId(bidId) },
          { $set: { status } }
        );
        res.send(result);
      }
    });

    // Delete a single bid
    app.delete("/bids/:id", verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid bid ID" });
      }
      
      const query = { _id: new ObjectId(id) };
      
      // Check if user owns this bid
      const existingBid = await bidsCollection.findOne(query);
      if (!existingBid) {
        return res.status(404).send({ message: "Bid not found" });
      }
      
      if (existingBid.buyer_email !== req.token_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      
      const result = await bidsCollection.deleteOne(query);
      res.send(result);
    });

    // Delete all bids for a product (used when product is deleted)
    app.delete("/bids/product/:productId", verifyFirebaseToken, async (req, res) => {
      const productId = req.params.productId;
      
      // Verify the requester owns this product
      const product = await productsCollection.findOne({
        _id: new ObjectId(productId),
      });
      
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      
      if (product.email !== req.token_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      
      const result = await bidsCollection.deleteMany({ product: productId });
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Smart server is running on port ${port}`);
});