const {PrismaClient}=require("C:/Users/30290/Desktop/fcmediaagent-replica/node_modules/@prisma/client");
(async()=>{const p=new PrismaClient();
const r=await p.mediaTaskRecord.findFirst({where:{taskId:"2120192437192581122"}});
console.log(JSON.stringify(r,null,1).slice(0,3000));
await p.$disconnect();})();
