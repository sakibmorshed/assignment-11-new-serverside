require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
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

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 5,
  minPoolSize: 1,
});
async function initializeServer() {
  try {
    const db = client.db("LocalChefBazaar");
    const mealsCollection = db.collection("meals");
    const reviewsCollection = db.collection("reviews");
    const favoritesCollection = db.collection("favorites");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");
    const requestsCollection = db.collection("requests");
    const paymentsCollection = db.collection("payments");

    //users api
    app.post("/users", async (req, res) => {
      const user = req.body;
      const exists = await usersCollection.findOne({ email: user.email });
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

      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });

    app.get("/users/:email", async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send(user);
    });

    app.get("/users", async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    app.patch("/users/fraud/:id", async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "fraud" } }
      );
      res.send(result);
    });

    //request to become admin/chef
    app.post("/requests", async (req, res) => {
      const { userId, userName, userEmail, requestType } = req.body;
      const alreadyRequested = await requestsCollection.findOne({
        userEmail,
        requestType,
        requestStatus: "pending",
      });

      if (alreadyRequested) {
        return res.status(400).send({
          message: "You already sent this request",
        });
      }

      const requestDoc = {
        userId,
        userName,
        userEmail,
        requestType,
        requestStatus: "pending",
        requestTime: new Date(),
      };

      const result = await requestsCollection.insertOne(requestDoc);
      res.send(result);
    });

    app.get("/requests", async (req, res) => {
      const result = await requestsCollection.find().toArray();
      res.send(result);
    });

    //admin approves/rejects request

    app.patch("/requests/:id", async (req, res) => {
      const { status } = req.body;
      const id = req.params.id;

      const request = await requestsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!request)
        return res.status(404).send({ message: "Request not found" });

      if (status === "approved") {
        const updateUser = {
          role: request.requestType,
        };

        if (request.requestType === "chef") {
          updateUser.chefId = "chef-" + Math.floor(1000 + Math.random() * 9000);
        }

        await usersCollection.updateOne(
          { email: request.userEmail },
          { $set: updateUser }
        );
      }

      await requestsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { requestStatus: status } }
      );

      res.send({ success: true });
    });

    //meals api

    app.post("/meals", verifyJWT, async (req, res) => {
      const meal = req.body;

      const email = req.tokenEmail;

      const chef = await usersCollection.findOne({ email });

      if (!chef || chef.role !== "chef") {
        return res.status(403).send({
          message: "Only chefs can create meals",
        });
      }

      if (chef.status === "fraud") {
        return res.status(403).send({
          message: "Fraud chefs cannot create meals",
        });
      }

      const mealData = {
        ...meal,
        chefEmail: chef.email,
        chefName: chef.name,
        chefId: chef.chefId,
        createdAt: new Date(),
      };

      const result = await mealsCollection.insertOne(mealData);
      res.send({ insertedId: result.insertedId });
    });

    app.get("/meals", async (req, res) => {
      try {
        const page = Number(req.query.page) || 1;
        const limit = 10;
        const skip = (page - 1) * limit;

        console.log(`Page: ${page}, Skip: ${skip}, Limit: ${limit}`);
        console.log("Full query object:", req.query);

        const { search, rating, price, sort } = req.query;

        let query = {};

        // 🔍 Search (foodName or chefName)
        if (search) {
          query.$or = [
            { foodName: { $regex: search, $options: "i" } },
            { chefName: { $regex: search, $options: "i" } },
          ];
        }

        // ⭐ Rating filter
        if (rating && rating !== "all") {
          query.rating = { $gte: Number(rating) };
        }

        //  Price filter
        if (price && price !== "all") {
          if (price === "low") query.price = { $lt: 20 };
          if (price === "medium") query.price = { $gte: 20, $lte: 50 };
          if (price === "high") query.price = { $gt: 50 };
        }

        // 🔃 Sorting
        let sortQuery = {};
        if (sort === "price-asc") sortQuery.price = 1;
        if (sort === "price-dsc") sortQuery.price = -1;
        if (sort === "rating-dsc") sortQuery.rating = -1;

        const meals = await mealsCollection
          .find(query)
          .sort(sortQuery)
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await mealsCollection.countDocuments(query);

        res.send({
          meals,
          totalPages: Math.ceil(total / limit),
        });
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/meals/chef/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;

      if (req.tokenEmail !== email) {
        return res.status(403).send({ message: "Forbidden access" });
      }
      const meals = await mealsCollection.find({ chefEmail: email }).toArray();
      res.send(meals);
    });

    app.get("/meals/:id", async (req, res) => {
      const id = req.params.id;
      const result = await mealsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.delete("/meals/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;

      const result = await mealsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });
    app.patch("/meals/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const updatedMeal = req.body;

      const result = await mealsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedMeal }
      );
      res.send(result);
    });

    //reviews api

    app.post("/reviews", async (req, res) => {
      const review = req.body;
      review.date = new Date();
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });
    app.get("/reviews", async (req, res) => {
      const result = await reviewsCollection.find().toArray();
      res.send(result);
    });

    app.get("/reviews/:foodId", async (req, res) => {
      const foodId = req.params.foodId;
      const result = await reviewsCollection
        .find({ foodId })
        .sort({ date: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/my-reviews/:email", async (req, res) => {
      const email = req.params.email;
      const result = await reviewsCollection
        .find({ reviewerEmail: email })
        .toArray();
      res.send(result);
    });

    app.patch("/reviews/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const result = await reviewsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData }
      );
      res.send(result);
    });

    app.delete("/reviews/:id", async (req, res) => {
      const result = await reviewsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    //orders api

    app.post("/orders", async (req, res) => {
      const order = req.body;

      const user = await usersCollection.findOne({
        email: order.userEmail,
      });

      if (user?.status === "fraud") {
        return res.status(403).send({
          message: "Fraud users cannot place orders",
        });
      }

      order.orderTime = new Date();
      order.paymentStatus = "pending";
      order.orderStatus = "pending";

      const result = await ordersCollection.insertOne(order);
      res.send(result);
    });
    app.get("/orders/chef/:chefId", async (req, res) => {
      const chefId = req.params.chefId;

      const result = await ordersCollection
        .find({ chefId })
        .sort({ orderedAt: -1 })
        .toArray();

      res.send(result);
    });

    app.get("/orders/:email", async (req, res) => {
      const email = req.params.email;

      const result = await ordersCollection
        .find({ userEmail: email })
        .sort({ orderAt: -1 })
        .toArray();
      console.log("orders found =", result.length);
      res.send(result);
    });

    app.patch("/orders/status/:id", async (req, res) => {
      const { orderStatus } = req.body;
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { orderStatus } }
      );
      res.send(result);
    });

    app.patch("/orders/payment/:id", async (req, res) => {
      const id = req.params.id;

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            paymentStatus: "paid",
            orderStatus: "accepted",
            paidAt: new Date(),
          },
        }
      );

      res.send(result);
    });

    //payments
    app.post("/payments", async (req, res) => {
      const payment = req.body;
      payment.paidAt = new Date();
      const result = await paymentsCollection.insertOne(payment);
      res.send(result);
    });

    app.get("/order/:id", async (req, res) => {
      const id = req.params.id;

      const result = await ordersCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!result) {
        return res.status(404).send({ message: "Order not found" });
      }

      res.send(result);
    });

    //Create-Payment-Intent

    app.post("/create-payment-intent", async (req, res) => {
      console.log("STRIPE KEY =", process.env.STRIPE_SECRET_KEY);
      const { price } = req.body;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(price * 100),
        currency: "usd",
        automatic_payment_methods: { enabled: true },
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.post("/favorites", async (req, res) => {
      const fav = req.body;

      const exists = await favoritesCollection.findOne({
        userEmail: fav.userEmail,
        mealId: fav.mealId,
      });

      if (exists) {
        return res.send({ message: "Already added" });
      }

      fav.addedTime = new Date();

      const result = await favoritesCollection.insertOne(fav);
      res.send(result);
    });

    app.get("/favorites/:email", async (req, res) => {
      const result = await favoritesCollection
        .find({ userEmail: req.params.email })
        .toArray();
      res.send(result);
    });

    app.delete("/favorites/:id", async (req, res) => {
      const result = await favoritesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    //admin stats

    app.get("/admin/stats", async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();
      const pendingOrders = await ordersCollection.countDocuments({
        orderStatus: { $ne: "delivered" },
      });

      const deliveredOrders = await ordersCollection.countDocuments({
        orderStatus: "delivered",
      });

      const payments = await paymentsCollection.find().toArray();
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
    });
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}

// Initialize routes after DB connection
let dbReady = false;
let dbError = null;

initializeServer()
  .then(() => {
    dbReady = true;
    console.log("✅ Database initialized successfully");
  })
  .catch((err) => {
    dbError = err;
    console.error("❌ Database initialization failed:", err);
  });

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.use((req, res, next) => {
  if (!dbReady) {
    return res
      .status(503)
      .json({ message: "Database not ready", error: dbError?.message });
  }
  next();
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
