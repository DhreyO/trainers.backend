const express = require('express');
const app = express();

app.use(express.json());

// Trainer product list (10 items)
let products = [
  { id: 1, name: "Nike Air Jordan 1 Low", price: 140, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Nike+Air+Jordan+1+Low.png", sizes: [7,8,9,10,11], stock: 12 },
  { id: 2, name: "Adidas  22", price: 160, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Adidas+22.png", sizes: [6,7,8,9,10], stock: 8 },
  { id: 3, name: "Nike Air Jordan Dub Zero", price: 110, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Nike+Air+Jordan+Dub+Zero.png", sizes: [7,8,9,10,12], stock: 20 },
  { id: 4, name: "Nike Air Jordan 1 High", price: 130, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Nike+Air+Jordan+1+Low.png", sizes: [7,8,9,10,11], stock: 10 },
  { id: 5, name: "Adidas strip", price: 100, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Adidas+Strip.png", sizes: [6,7,8,9,10], stock: 15 },
  { id: 6, name: "Jordan 1 Retro High", price: 180, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Jordan+1+Retro+High.png", sizes: [7,8,9,10,11], stock: 5 },
  { id: 7, name: "Nike Air Trainer", price: 120, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Nike+Air+Trainer.png", sizes: [6,7,8,9,10], stock: 9 },
  { id: 8, name: "Yeezy Boost 350 V2", price: 220, image: "https://dhrey-store-v3.s3.eu-west-2.amazonaws.com/Yeezy+Boost+350.png", sizes: [7,8,9,10], stock: 4 }
];

// GET all trainers
app.get('/products', (req, res) => {
  res.json(products);
});

// GET one trainer
app.get('/products/:id', (req, res) => {
  const product = products.find(p => p.id === parseInt(req.params.id));
  if (!product) return res.status(404).json({ message: "Trainer not found" });
  res.json(product);
});

// POST new trainer
app.post('/products', (req, res) => {
  const newProduct = {
    id: products.length + 1,
    name: req.body.name,
    price: req.body.price,
    sizes: req.body.sizes,
    stock: req.body.stock
  };
  products.push(newProduct);
  res.status(201).json(newProduct);
});

app.listen(3000, () => console.log("Server running on port 3000"));
