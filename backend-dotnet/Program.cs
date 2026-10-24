using Bridge.Demo.V1;
using Grpc.Core;
using Microsoft.AspNetCore.Server.Kestrel.Core;

if (args.Contains("--healthcheck", StringComparer.Ordinal))
{
    using var client = new System.Net.Sockets.TcpClient();
    await client.ConnectAsync("127.0.0.1", 50051).WaitAsync(TimeSpan.FromSeconds(2));
    return;
}

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options =>
{
    options.ListenAnyIP(50051, listen => listen.Protocols = HttpProtocols.Http2);
});
builder.Services.AddGrpc(options =>
{
    options.MaxReceiveMessageSize = 1024 * 1024;
    options.MaxSendMessageSize = 1024 * 1024;
});

var app = builder.Build();
app.MapGrpcService<Demo>();
await app.RunAsync();

sealed class Demo : DemoService.DemoServiceBase
{
    public override async Task<Message> Echo(Message request, ServerCallContext context)
    {
        if (request.Text == "error")
            throw new RpcException(new Status(StatusCode.InvalidArgument, "requested demo error"));
        await Task.Delay(Math.Clamp(request.DelayMs, 0, 10_000), context.CancellationToken);
        context.ResponseTrailers.Add("demo-trailer", "echo-complete");
        return request;
    }

    public override async Task Count(
        Message request,
        IServerStreamWriter<Message> responseStream,
        ServerCallContext context)
    {
        for (var number = 1; number <= Math.Clamp(request.Number, 1, 1_000); number++)
        {
            await Task.Delay(Math.Clamp(request.DelayMs, 10, 10_000), context.CancellationToken);
            await responseStream.WriteAsync(new Message { Text = $"tick {number}", Number = number });
        }
        context.ResponseTrailers.Add("demo-trailer", "count-complete");
    }

    public override async Task<Message> Collect(
        IAsyncStreamReader<Message> requestStream,
        ServerCallContext context)
    {
        long total = 0;
        var count = 0;
        await foreach (var request in requestStream.ReadAllAsync(context.CancellationToken))
        {
            total += request.Number;
            count++;
        }
        if (total is < int.MinValue or > int.MaxValue)
            throw new RpcException(new Status(StatusCode.OutOfRange, "sum exceeds int32"));
        return new Message { Text = $"collected {count} messages", Number = (int)total };
    }

    public override async Task Chat(
        IAsyncStreamReader<Message> requestStream,
        IServerStreamWriter<Message> responseStream,
        ServerCallContext context)
    {
        await context.WriteResponseHeadersAsync(new Metadata { { "demo-header", "chat-open" } });
        await foreach (var request in requestStream.ReadAllAsync(context.CancellationToken))
        {
            await responseStream.WriteAsync(new Message
            {
                Text = $".NET received: {request.Text}",
                Number = request.Number,
            });
        }
        context.ResponseTrailers.Add("demo-trailer", "chat-complete");
    }
}
