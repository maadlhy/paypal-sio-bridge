console.log('Mini server boot');
const express=require('express');
const app=express();
app.get('/health',(_req,res)=>res.json({ok:true}));
app.listen(3001,()=>console.log('Mini server on :3001'));
