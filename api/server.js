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
 cached = global.mongoose = { conn:null, promise:null }
}

async function connectDB(){

 if(cached.conn) return cached.conn

 if(!cached.promise){

  cached.promise = mongoose.connect(
   process.env.MONGO_URI,
   {bufferCommands:false}
  ).then(m=>m)

 }

 cached.conn = await cached.promise

 return cached.conn
}

/* ---------------- TELEGRAM SUB CHECK ---------------- */

async function checkSubscription(bot_token,user_id,channels){

 const checks = channels.map(async(channel)=>{

  const url = `https://api.telegram.org/bot${bot_token}/getChatMember?chat_id=${channel}&user_id=${user_id}`

  try{

   const response = await fetch(url)
   const data = await response.json()

   if(!data.ok) return false

   const status = data.result.status

   if(status==="left" || status==="kicked"){
    return false
   }

   return true

  }catch(e){
   return false
  }

 })

 const results = await Promise.all(checks)

 return results.every(v=>v===true)
}

/* ---------------- GENERATE INVITE LINK ---------------- */

async function generateInviteLink(bot_token,chat_id){

 const url = `https://api.telegram.org/bot${bot_token}/createChatInviteLink`

 try{

  const response = await fetch(url,{
   method:"POST",
   headers:{
    "Content-Type":"application/json"
   },
   body:JSON.stringify({
    chat_id:chat_id,
    member_limit:1,
    expire_date: Math.floor(Date.now()/1000) + 600
   })
  })

  const data = await response.json()

  if(!data.ok) return null

  return data.result.invite_link

 }catch(e){
  return null
 }

}

/* ---------------- SCHEMAS ---------------- */

const PollSchema = new mongoose.Schema({

 poll_id:{
  type:String,
  unique:true
 },

 user_id:Number,

 main_channel:String,

 sponsors:[String],

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
  enum:["Manual","Vote Target"],
  default:"Manual"
 },

 vote_target:Number,

 lock:{
  type:String,
  enum:["On","Off"],
  default:"Off"
 },

 notify:{
  type:String,
  enum:["On","Off"],
  default:"Off"
 },

 status:{
  type:String,
  enum:["active","ended"],
  default:"active"
 },

 delete_at:Date,

 created_at:{
  type:Date,
  default:Date.now
 }

})

const VoteSchema = new mongoose.Schema({

 poll_id:String,
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

app.get("/",async(req,res)=>{

 const interfaces = os.networkInterfaces()

 let serverIP = null

 for(const name of Object.keys(interfaces)){
  for(const net of interfaces[name]){
   if(net.family==="IPv4" && !net.internal){
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

app.post("/api/create",async(req,res)=>{

 await connectDB()

 const {
  poll_id,
  user_id,
  main_channel,
  sponsors,
  question,
  options,
  mode,
  lock,
  notify,
  vote_target
 } = req.body

 if(!poll_id || !question || !options)
  return res.json({error:"Invalid poll data"})

 const formatted = options.map((o,i)=>({
  id:i+1,
  text:o,
  votes:0
 }))

 const poll = await Poll.create({

  poll_id,
  user_id,
  main_channel,
  sponsors,
  question,
  options:formatted,
  mode:mode || "Manual",
  vote_target:vote_target || null,
  lock:lock || "Off",
  notify:notify || "Off"

 })

 res.json(poll)

})

/* ---------------- GET POLL ---------------- */

app.get("/api/poll/:id",async(req,res)=>{

 await connectDB()

 const poll = await Poll.findOne({
  poll_id:req.params.id
 })

 if(!poll)
  return res.status(404).json({error:"Poll not found"})

 res.json(poll)

})

/* ---------------- VOTE ---------------- */

app.post("/api/vote",async(req,res)=>{

 await connectDB()

 const {poll_id,user_id,option_id,bot_token} = req.body

 const poll = await Poll.findOne({poll_id})

 if(!poll)
  return res.json({message:"poll was not found"})

 if(poll.status==="ended")
  return res.json({message:"poll was ended"})

 const optionExists = poll.options.find(o=>o.id===option_id)

 if(!optionExists)
  return res.json({error:"Invalid option"})

 /* -------- FORCE SUB CHECK -------- */

 const channels = [
  poll.main_channel,
  ...(poll.sponsors || [])
 ]

 const subscribed = await checkSubscription(
  bot_token,
  user_id,
  channels
 )

 if(!subscribed){

  const inviteLinks = {}

  for(const ch of channels){
   inviteLinks[ch] = await generateInviteLink(bot_token,ch)
  }

  return res.json({
   message:"account is not joined the required channel.Please Join",
   channels:channels,
   invite_links:inviteLinks
  })

 }

 /* -------- VOTE LOGIC -------- */

 const existing = await Vote.findOne({
  poll_id,
  user_id
 })

 if(poll.lock==="On" && existing)
  return res.json({message:"vote is locked",poll_id:poll_id})

 if(existing){

  if(existing.option_id===option_id)
   return res.json({message:"already voted",poll_id:poll_id})

  await Poll.updateOne(
   {poll_id,"options.id":existing.option_id},
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
  {poll_id,"options.id":option_id},
  {$inc:{"options.$.votes":1}}
 )

 const updatedPoll = await Poll.findOne({poll_id})

 const totalVotes = updatedPoll.options.reduce(
  (sum,o)=>sum+o.votes,0
 )

 if(
  updatedPoll.mode==="Vote Target" &&
  totalVotes>=updatedPoll.vote_target
 ){

  updatedPoll.status="ended"

  updatedPoll.delete_at = new Date(
   Date.now()+2*60*60*1000
  )

  await updatedPoll.save()

 }

 res.json({
  message:"vote is counted",
  poll_id:poll_id
 })

})

/* ---------------- END POLL ---------------- */

app.post("/api/endpoll",async(req,res)=>{

 await connectDB()

 const {poll_id,user_id} = req.body

 const poll = await Poll.findOne({poll_id})

 if(!poll)
  return res.json({error:"Poll not found"})

 if(poll.user_id!==user_id)
  return res.json({error:"Not authorized"})

 poll.status="ended"

 poll.delete_at = new Date(
  Date.now()+2*60*60*1000
 )

 await poll.save()

 res.json({message:"Poll ended"})

})

/* ---------------- CLEANUP ---------------- */

app.get("/api/cleanup",async(req,res)=>{

 await connectDB()

 const result = await Poll.deleteMany({
  delete_at:{ $lte:new Date() }
 })

 res.json({
  deleted:result.deletedCount
 })

})

app.post("/api/remove-vote", async (req,res)=>{

 await connectDB()

 const {poll_id,user_id} = req.body

 const vote = await Vote.findOne({
  poll_id,
  user_id
 })

 if(!vote){
  return res.json({
   message:"No vote found"
  })
 }

 await Poll.updateOne(
  {poll_id,"options.id":vote.option_id},
  {$inc:{"options.$.votes":-1}}
 )

 await Vote.deleteOne({
  poll_id,
  user_id
 })

 res.json({
  message:"Vote removed",
  poll_id:poll_id
 })

})

export default app
