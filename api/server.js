import express from "express"
import mongoose from "mongoose"
import cors from "cors"

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

const Poll = mongoose.models.Poll || mongoose.model("Poll",PollSchema)
const Vote = mongoose.models.Vote || mongoose.model("Vote",VoteSchema)

/* ---------------- CREATE POLL ---------------- */

app.post("/api/create", async (req,res)=>{

 await connectDB()

 const {question,options,mode,end_time,created_by}=req.body

 const formatted = options.map((o,i)=>({
   id:i+1,
   text:o,
   votes:0
 }))

 const poll = await Poll.create({
   question,
   options:formatted,
   mode:mode || "unlock",
   end_time,
   created_by
 })

 res.json(poll)

})

/* ---------------- GET POLL ---------------- */

app.get("/api/poll/:id", async (req,res)=>{

 await connectDB()

 const poll = await Poll.findById(req.params.id)

 if(!poll) return res.status(404).json({error:"Poll not found"})

 if(poll.end_time && new Date()>poll.end_time){

   poll.status="ended"
   await poll.save()

 }

 res.json(poll)

})

/* ---------------- VOTE ---------------- */

app.post("/api/vote", async (req,res)=>{

 await connectDB()

 const {poll_id,user_id,option_id}=req.body

 const poll = await Poll.findById(poll_id)

 if(!poll) return res.json({error:"Poll not found"})

 if(poll.end_time && new Date()>poll.end_time){

   poll.status="ended"
   await poll.save()

   return res.json({error:"Poll expired"})
 }

 const existing = await Vote.findOne({poll_id,user_id})

 /* LOCK MODE */

 if(poll.mode==="lock" && existing){

   return res.json({
     error:"Vote locked"
   })

 }

 /* CHANGE VOTE */

 if(existing){

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

/* ---------------- REMOVE USER VOTES ---------------- */

app.post("/api/remove-votes", async (req,res)=>{

 await connectDB()

 const {user_id}=req.body

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

export default app
