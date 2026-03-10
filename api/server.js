import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import os from "os"

const app = express()

app.use(cors())
app.use(express.json())

/* ---------------- DATABASE ---------------- */

let cached = global.mongoose

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null }
}

async function connectDB() {

  if (cached.conn) return cached.conn

  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI,{
      bufferCommands:false
    }).then(m=>m)
  }

  cached.conn = await cached.promise
  return cached.conn
}

/* ---------------- SCHEMAS ---------------- */

const PollSchema = new mongoose.Schema({

  question:String,

  options:[
    {
      _id:false,
      id:Number,
      text:String,
      votes:{type:Number,default:0}
    }
  ],

  mode:{
    type:String,
    enum:["lock","unlock"],
    default:"unlock"
  },

  end_time:Date,

  status:{
    type:String,
    enum:["active","ended"],
    default:"active"
  },

  created_by:Number,

  force_sub_channel:{
    type:String,
    default:null
  },

  delete_at:Date,

  created_at:{
    type:Date,
    default:Date.now
  }

})

const VoteSchema = new mongoose.Schema({

  poll_id:mongoose.Schema.Types.ObjectId,
  user_id:Number,
  option_id:Number,

  created_at:{
    type:Date,
    default:Date.now
  }

})

VoteSchema.index({poll_id:1,user_id:1},{unique:true})

const Poll = mongoose.models.Poll || mongoose.model("Poll",PollSchema)
const Vote = mongoose.models.Vote || mongoose.model("Vote",VoteSchema)

/* ---------------- HEALTH ---------------- */

app.get("/", async (req,res)=>{

 const interfaces = os.networkInterfaces()

 let serverIP = null

 for (const name of Object.keys(interfaces)) {
  for (const net of interfaces[name]) {
   if (net.family === "IPv4" && !net.internal) {
    serverIP = net.address
   }
  }
 }

 res.json({
  status:"API running",
  server_ip:serverIP,
  region:process.env.VERCEL_REGION,
  time:new Date()
 })

})

/* ---------------- CREATE POLL ---------------- */

app.post("/api/create", async (req,res)=>{

 await connectDB()

 const {
  question,
  options,
  mode,
  end_time,
  created_by,
  force_sub_channel
 } = req.body

 const formatted = options.map((o,i)=>({
   id:i+1,
   text:o,
   votes:0
 }))

 const pollData = {
  question,
  options:formatted,
  mode:mode || "unlock",
  end_time,
  created_by
 }

 if(force_sub_channel){
  pollData.force_sub_channel = force_sub_channel
 }

 const poll = await Poll.create(pollData)

 res.json(poll)

})

/* ---------------- GET POLL ---------------- */

app.get("/api/poll/:id", async (req,res)=>{

 await connectDB()

 const poll = await Poll.findById(req.params.id)

 if(!poll)
  return res.status(404).json({error:"Poll not found"})

 if(poll.end_time && new Date()>poll.end_time){

  poll.status="ended"

  if(!poll.delete_at){
   poll.delete_at = new Date(Date.now()+12*60*60*1000)
  }

  await poll.save()

 }

 res.json(poll)

})

/* ---------------- VOTE ---------------- */

app.post("/api/vote", async (req,res)=>{

 await connectDB()

 const {poll_id,user_id,option_id} = req.body

 const poll = await Poll.findById(poll_id)

 if(!poll)
  return res.json({error:"Poll not found"})

 if(poll.status==="ended")
  return res.json({error:"Poll ended"})

 if(poll.end_time && new Date()>poll.end_time){

  poll.status="ended"
  poll.delete_at = new Date(Date.now()+12*60*60*1000)

  await poll.save()

  return res.json({error:"Poll expired"})
 }

 const existing = await Vote.findOne({poll_id,user_id})

 if(poll.mode==="lock" && existing)
  return res.json({error:"Vote locked"})

 if(existing){

  if(existing.option_id === option_id)
   return res.json({message:"Already voted"})

  await Poll.updateOne(
   {_id:poll_id,"options.id":existing.option_id},
   {$inc:{"options.$.votes":-1}}
  )

  existing.option_id = option_id
  await existing.save()

 }

 else{

  await Vote.create({
   poll_id,
   user_id,
   option_id
  })

 }

 await Poll.updateOne(
  {_id:poll_id,"options.id":option_id},
  {$inc:{"options.$.votes":1}}
 )

 res.json({message:"Vote counted"})

})

/* ---------------- END POLL ---------------- */

app.post("/api/endpoll", async (req,res)=>{

 await connectDB()

 const {poll_id,user_id} = req.body

 const poll = await Poll.findById(poll_id)

 if(!poll)
  return res.json({error:"Poll not found"})

 if(poll.created_by !== user_id)
  return res.json({error:"Not authorized"})

 poll.status = "ended"

 poll.delete_at = new Date(Date.now()+12*60*60*1000)

 await poll.save()

 res.json({message:"Poll ended"})

})

/* ---------------- REMOVE USER VOTES ---------------- */

app.post("/api/remove-votes", async (req,res)=>{

 await connectDB()

 const {user_id} = req.body

 const votes = await Vote.find({user_id})

 for(const vote of votes){

  await Poll.updateOne(
   {_id:vote.poll_id,"options.id":vote.option_id},
   {$inc:{"options.$.votes":-1}}
  )

 }

 await Vote.deleteMany({user_id})

 res.json({message:"Votes removed"})

})

/* ---------------- CLEANUP EXPIRED POLLS ---------------- */

app.get("/api/cleanup", async (req,res)=>{

 await connectDB()

 const result = await Poll.deleteMany({
  delete_at:{ $lte:new Date() }
 })

 res.json({
  deleted:result.deletedCount
 })

})

export default app
