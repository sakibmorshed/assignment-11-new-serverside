require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const Stripe = require("stripe");

console.log("📦 Dependencies loaded");

const port = process.env.PORT || 3000;

try {
  console.log("🔑 Initializing Firebase Admin...");
  const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
    "utf-8"
  );
  const serviceAccount = JSON.parse(decoded);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("✅ Firebase Admin initialized");
} catch (err) {
  console.error("❌ Firebase initialization failed:", err.message);
  throw err;
}

try {
  console.log("💳 Initializing Stripe...");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log("✅ Stripe initialized");
} catch (err) {
  console.error("❌ Stripe initialization failed:", err.message);
  throw err;
}

// Create Express app - OUTSIDE try block
const app = express();

// CORS Configuration
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://localchefbazaar-c2f05.web.app",
      "https://localchefbazaar-frontend.vercel.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// MongoDB Client Setup
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 1,
  minPoolSize: 0,
  socketTimeoutMS: 90000,
  connectTimeoutMS: 90000,
  serverSelectionTimeoutMS: 90000,
  retryWrites: true,
});

// Global collections reference
let collections = {};

// Initialize DB Connection
async function initializeDB() {
  if (Object.keys(collections).length > 0) return;

  try {
    if (!client.topology || !client.topology.isConnected()) {
      await client.connect();
      console.log("✅ Connected to MongoDB");
    }
    const db = client.db("LocalChefBazaar");
    collections = {
      meals: db.collection("meals"),
      reviews: db.collection("reviews"),
      favorites: db.collection("favorites"),
      orders: db.collection("orders"),
      users: db.collection("users"),
      requests: db.collection("requests"),
      payments: db.collection("payments"),
    };
    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Ping successful");
  } catch (err) {
    console.error("❌ Database connection error:", err);
    throw err;
  }
}

// JWT Middleware
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Routes - ALL ROUTES DEFINED HERE

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Root
app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

// Meals
app.get("/meals", async (req, res) => {
  try {
    await initializeDB();
    const page = Number(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const { search, rating, price, sort } = req.query;

    let query = {};
    if (search) {
      query.$or = [
        { foodName: { $regex: search, $options: "i" } },
        { chefName: { $regex: search, $options: "i" } },
      ];
    }
    if (rating && rating !== "all") {
      query.rating = { $gte: Number(rating) };
    }
    if (price && price !== "all") {
      if (price === "low") query.price = { $lt: 20 };
      if (price === "medium") query.price = { $gte: 20, $lte: 50 };
      if (price === "high") query.price = { $gt: 50 };
    }

    let sortQuery = {};
    if (sort === "price-asc") sortQuery.price = 1;
    if (sort === "price-dsc") sortQuery.price = -1;
    if (sort === "rating-dsc") sortQuery.rating = -1;

    const meals = await collections.meals
      .find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await collections.meals.countDocuments(query);

    res.send({
      meals,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("GET /meals error:", err);
    res.status(500).send({ message: "Server error", error: err.message });
  }
});

app.get("/meals/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.meals.findOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.post("/meals", verifyJWT, async (req, res) => {
  try {
    await initializeDB();
    const meal = req.body;
    const email = req.tokenEmail;
    const chef = await collections.users.findOne({ email });

    if (!chef || chef.role !== "chef") {
      return res.status(403).send({ message: "Only chefs can create meals" });
    }
    if (chef.status === "fraud") {
      return res
        .status(403)
        .send({ message: "Fraud chefs cannot create meals" });
    }

    const mealData = {
      ...meal,
      chefEmail: chef.email,
      chefName: chef.name,
      chefId: chef.chefId,
      createdAt: new Date(),
    };

    const result = await collections.meals.insertOne(mealData);
    res.send({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.delete("/meals/:id", verifyJWT, async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.meals.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.patch("/meals/:id", verifyJWT, async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.meals.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: req.body }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/meals/chef/:email", verifyJWT, async (req, res) => {
  try {
    await initializeDB();
    const email = req.params.email;
    if (req.tokenEmail !== email) {
      return res.status(403).send({ message: "Forbidden access" });
    }
    const meals = await collections.meals.find({ chefEmail: email }).toArray();
    res.send(meals);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Users
app.post("/users", async (req, res) => {
  try {
    await initializeDB();
    const user = req.body;
    const exists = await collections.users.findOne({ email: user.email });
    if (exists) {
      return res.send({ message: "User already exists" });
    }
    const newUser = {
      name: user.name,
      email: user.email,
      photo: user.photo,
      role: "user",
      status: "active",
      createdAt: new Date(),
    };
    const result = await collections.users.insertOne(newUser);
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/users/:email", async (req, res) => {
  try {
    await initializeDB();
    const user = await collections.users.findOne({ email: req.params.email });
    res.send(user);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/users", async (req, res) => {
  try {
    await initializeDB();
    const users = await collections.users.find().toArray();
    res.send(users);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.patch("/users/fraud/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.users.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: "fraud" } }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Requests
app.post("/requests", async (req, res) => {
  try {
    await initializeDB();
    const { userId, userName, userEmail, requestType } = req.body;
    const alreadyRequested = await collections.requests.findOne({
      userEmail,
      requestType,
      requestStatus: "pending",
    });

    if (alreadyRequested) {
      return res.status(400).send({ message: "You already sent this request" });
    }

    const requestDoc = {
      userId,
      userName,
      userEmail,
      requestType,
      requestStatus: "pending",
      requestTime: new Date(),
    };

    const result = await collections.requests.insertOne(requestDoc);
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/requests", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.requests.find().toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.patch("/requests/:id", async (req, res) => {
  try {
    await initializeDB();
    const { status } = req.body;
    const id = req.params.id;

    const request = await collections.requests.findOne({
      _id: new ObjectId(id),
    });
    if (!request) return res.status(404).send({ message: "Request not found" });

    if (status === "approved") {
      const updateUser = { role: request.requestType };
      if (request.requestType === "chef") {
        updateUser.chefId = "chef-" + Math.floor(1000 + Math.random() * 9000);
      }
      await collections.users.updateOne(
        { email: request.userEmail },
        { $set: updateUser }
      );
    }

    await collections.requests.updateOne(
      { _id: new ObjectId(id) },
      { $set: { requestStatus: status } }
    );

    res.send({ success: true });
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Reviews
app.post("/reviews", async (req, res) => {
  try {
    await initializeDB();
    const review = req.body;
    review.date = new Date();
    const result = await collections.reviews.insertOne(review);
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/reviews", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.reviews.find().toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/reviews/:foodId", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.reviews
      .find({ foodId: req.params.foodId })
      .sort({ date: -1 })
      .toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/my-reviews/:email", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.reviews
      .find({ reviewerEmail: req.params.email })
      .toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.patch("/reviews/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.reviews.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: req.body }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.delete("/reviews/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.reviews.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Orders
app.post("/orders", async (req, res) => {
  try {
    await initializeDB();
    const order = req.body;
    const user = await collections.users.findOne({ email: order.userEmail });

    if (user?.status === "fraud") {
      return res
        .status(403)
        .send({ message: "Fraud users cannot place orders" });
    }

    order.orderTime = new Date();
    order.paymentStatus = "pending";
    order.orderStatus = "pending";

    const result = await collections.orders.insertOne(order);
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/orders/:email", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.orders
      .find({ userEmail: req.params.email })
      .sort({ orderAt: -1 })
      .toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/orders/chef/:chefId", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.orders
      .find({ chefId: req.params.chefId })
      .sort({ orderedAt: -1 })
      .toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.patch("/orders/status/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.orders.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { orderStatus: req.body.orderStatus } }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.patch("/orders/payment/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.orders.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          paymentStatus: "paid",
          orderStatus: "accepted",
          paidAt: new Date(),
        },
      }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/order/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.orders.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!result) {
      return res.status(404).send({ message: "Order not found" });
    }
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Favorites
app.post("/favorites", async (req, res) => {
  try {
    await initializeDB();
    const fav = req.body;
    const exists = await collections.favorites.findOne({
      userEmail: fav.userEmail,
      mealId: fav.mealId,
    });

    if (exists) {
      return res.send({ message: "Already added" });
    }

    fav.addedTime = new Date();
    const result = await collections.favorites.insertOne(fav);
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.get("/favorites/:email", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.favorites
      .find({ userEmail: req.params.email })
      .toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.delete("/favorites/:id", async (req, res) => {
  try {
    await initializeDB();
    const result = await collections.favorites.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Payments
app.post("/payments", async (req, res) => {
  try {
    await initializeDB();
    const payment = req.body;
    payment.paidAt = new Date();
    const result = await collections.payments.insertOne(payment);
    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { price } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100),
      currency: "usd",
      automatic_payment_methods: { enabled: true },
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Admin Stats
app.get("/admin/stats", async (req, res) => {
  try {
    await initializeDB();
    const totalUsers = await collections.users.countDocuments();
    const pendingOrders = await collections.orders.countDocuments({
      orderStatus: { $ne: "delivered" },
    });
    const deliveredOrders = await collections.orders.countDocuments({
      orderStatus: "delivered",
    });
    const payments = await collections.payments.find().toArray();
    const totalPaymentAmount = payments.reduce(
      (sum, p) => sum + (p.amount || 0),
      0
    );

    res.send({
      totalUsers,
      pendingOrders,
      deliveredOrders,
      totalPaymentAmount,
    });
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// Export for Vercel
console.log("📤 Exporting Express app for Vercel");
module.exports = app;

// Local development server
if (require.main === module) {
  app.listen(port, () => {
    console.log(`✅ Server is running on port ${port}`);
  });
}
