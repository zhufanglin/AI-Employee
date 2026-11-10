const {PrismaClient} = require("C:/Users/30290/Desktop/fcmediaagent-replica/node_modules/@prisma/client");
(async()=>{const p=new PrismaClient();const r=await p.mediaPricing.findMany();console.log(JSON.stringify(r,null,1));await p.$disconnect();})();
